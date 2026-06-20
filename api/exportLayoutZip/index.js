const { BlobServiceClient } = require('@azure/storage-blob');
const archiver = require('archiver');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER    = 'ad-proofs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

function zoneAbbr(zoneId) {
  return zoneId.split('-').slice(1).join('').toLowerCase();
}

function pageLabel(n) {
  return 'pg' + String(n).padStart(2, '0');
}

// Given a 2P filename, derive the 2P1 and 2P2 variants
// e.g. StewartDoorNB_0726_2P_Z1.pdf → StewartDoorNB_0726_2P1_Z1.pdf & _2P2_Z1.pdf
function get2PVariants(originalPath) {
  const fname  = originalPath.split('/').pop();
  const dir    = originalPath.substring(0, originalPath.lastIndexOf('/') + 1);
  const noExt  = fname.replace(/\.pdf$/i, '');
  const p2p1   = dir + noExt.replace(/_2P(_|$)/i, '_2P1$1') + '.pdf';
  const p2p2   = dir + noExt.replace(/_2P(_|$)/i, '_2P2$1') + '.pdf';
  return { p2p1, p2p2 };
}

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res={status:200,headers:CORS,body:'{}'}; context.done(); return; }

  const { month, year, zoneId, layout } = req.body || {};
  if (!month || !year || !zoneId || !layout) {
    context.res={status:400,headers:CORS,body:JSON.stringify({error:'Missing fields'})}; context.done(); return;
  }

  const abbr      = zoneAbbr(zoneId);
  const spreads   = layout.spreads || [];
  const totalSp   = spreads.length;
  const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
  const container = blobSvc.getContainerClient(CONTAINER);

  // Build page list: { pageNum, path, note, missing }
  const pages = [];

  function addPage(pageNum, slot, label) {
    if (!slot) {
      pages.push({ pageNum, path:null, note:'EMPTY', missing:true });
    } else if (slot.type === 'hp-pair') {
      const l = slot.left  ? slot.left.business  : '(empty)';
      const r = slot.right ? slot.right.business : '(empty)';
      pages.push({ pageNum, path:null, note:'HP PAIR: '+l+' | '+r+' — supply combined file', missing:true, needsCombine:true });
    } else if (slot.size === '2P') {
      const variants = get2PVariants(slot.path);
      pages.push({ pageNum, path:variants.p2p1, note:'2P LEFT (2P1) — '+slot.filename, is2P:true, side:'left', fallback:slot.path });
    } else {
      pages.push({ pageNum, path:slot.path, note:label+' — '+slot.filename });
    }
  }

  for (let si = 0; si < totalSp; si++) {
    const sp   = spreads[si];
    const isFC = si === 0;
    const isBP = si === totalSp - 1;

    if (isFC) {
      addPage(1, sp.left, 'FC');
    } else if (isBP) {
      const lastPage = (totalSp - 1) * 2;
      addPage(lastPage, sp.right, 'BP');
    } else {
      const pageL = si * 2;
      const pageR = si * 2 + 1;
      const is2P  = sp.left && sp.left.size === '2P';

      if (is2P) {
        const variants = get2PVariants(sp.left.path);
        pages.push({ pageNum:pageL, path:variants.p2p1, note:'2P LEFT  (2P1) — '+sp.left.filename, is2P:true, side:'left',  fallback:sp.left.path });
        pages.push({ pageNum:pageR, path:variants.p2p2, note:'2P RIGHT (2P2) — '+sp.left.filename, is2P:true, side:'right', fallback:sp.left.path });
      } else {
        addPage(pageL, sp.left,  'FP left');
        addPage(pageR, sp.right, 'FP right');
      }
    }
  }

  // Build layout sheet
  let sheet = 'PRINT LAYOUT — Zone ' + zoneId + ' — ' + month + '/' + year + '\n';
  sheet += '='.repeat(60) + '\n\n';
  pages.forEach(function(p) {
    const fname = abbr + '.' + pageLabel(p.pageNum) + '.pdf';
    sheet += pageLabel(p.pageNum).toUpperCase() + '  →  ' + fname + '\n';
    sheet += '      ' + p.note + '\n\n';
  });

  try {
    const chunks  = [];
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('data', function(c){ chunks.push(c); });
    const done = new Promise(function(res,rej){ archive.on('end',res); archive.on('error',rej); });

    archive.append(sheet, { name: abbr + '-layout-' + month + year + '.txt' });

    for (const p of pages) {
      const fname = abbr + '.' + pageLabel(p.pageNum) + '.pdf';

      if (!p.path) {
        // Missing or needs combine
        const txt = p.needsCombine
          ? 'COMBINED FILE NEEDED\n\n' + p.note + '\n\nExpected output file: ' + fname
          : 'PAGE EMPTY — no ad placed.\n\nExpected: ' + fname;
        archive.append(txt, { name: fname.replace('.pdf', '.MISSING.txt') });
        continue;
      }

      // Try to fetch the file
      let fetched = false;
      try {
        const buf = await container.getBlockBlobClient(p.path).downloadToBuffer();
        archive.append(buf, { name: fname });
        context.log('✓', fname, '←', p.path);
        fetched = true;
      } catch(e) {
        context.log.warn('Not found:', p.path);
      }

      // For 2P variants: if 2P1/2P2 file not found, fall back to original 2P file with a note
      if (!fetched && p.is2P && p.fallback) {
        try {
          const buf = await container.getBlockBlobClient(p.fallback).downloadToBuffer();
          archive.append(buf, { name: fname });
          context.log('✓ (fallback)', fname, '←', p.fallback);
          fetched = true;
        } catch(e2) {}
      }

      if (!fetched) {
        archive.append(
          'FILE NOT FOUND\n\nLooked for: ' + p.path + (p.fallback ? '\nAlso tried: ' + p.fallback : '') + '\n\nNote: ' + p.note,
          { name: fname.replace('.pdf', '.ERROR.txt') }
        );
      }
    }

    archive.finalize();
    await done;

    const zipBuf = Buffer.concat(chunks);
    const zipName = abbr + '-layout-' + month + year + '.zip';
    context.log('ZIP ready:', zipName, zipBuf.length, 'bytes');

    context.res = {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type':        'application/zip',
        'Content-Disposition': 'attachment; filename="' + zipName + '"',
        'Content-Length':      zipBuf.length.toString()
      },
      body:  zipBuf.toString('base64'),
      isRaw: false
    };
  } catch(e) {
    context.log.error('exportLayoutZip error:', e.message);
    context.res = { status:500, headers:CORS, body: JSON.stringify({ error: e.message }) };
  }
  context.done();
};
