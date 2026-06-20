// api/exportLayoutZip/index.js
// Pure Node.js ZIP using only built-in modules - no archiver dependency needed
const { BlobServiceClient } = require('@azure/storage-blob');
const zlib = require('zlib');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER    = 'ad-proofs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

function zoneAbbr(zid)   { return zid.split('-').slice(1).join('').toLowerCase(); }
function pageLabel(n)     { return 'pg' + String(n).padStart(2,'0'); }

function get2PVariants(path) {
  const dir   = path.substring(0, path.lastIndexOf('/')+1);
  const noExt = path.split('/').pop().replace(/\.pdf$/i,'');
  return {
    p2p1: dir + noExt.replace(/_2P(_|$)/i,'_2P1$1') + '.pdf',
    p2p2: dir + noExt.replace(/_2P(_|$)/i,'_2P2$1') + '.pdf'
  };
}

// --- Minimal ZIP builder (store + deflate) ---
function crc32(buf) {
  const table = crc32.t || (crc32.t = (function(){
    const t=[]; for(let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[i]=c;} return t;
  })());
  let c=0xFFFFFFFF;
  for(let i=0;i<buf.length;i++) c=table[(c^buf[i])&0xFF]^(c>>>8);
  return (c^0xFFFFFFFF)>>>0;
}

function uint16LE(n){ const b=Buffer.alloc(2); b.writeUInt16LE(n,0); return b; }
function uint32LE(n){ const b=Buffer.alloc(4); b.writeUInt32LE(n,0); return b; }

function buildZip(entries) {
  // entries: [{name:string, data:Buffer}]
  const localHeaders = [];
  const centralDirs  = [];
  let offset = 0;

  for (const e of entries) {
    const nameB    = Buffer.from(e.name, 'utf8');
    const crc      = crc32(e.data);
    const deflated = zlib.deflateRawSync(e.data, { level: 6 });
    const useDeflate = deflated.length < e.data.length;
    const compData = useDeflate ? deflated : e.data;
    const method   = useDeflate ? 8 : 0;

    const local = Buffer.concat([
      Buffer.from([0x50,0x4B,0x03,0x04]),
      uint16LE(20),        // version needed
      uint16LE(0),         // flags
      uint16LE(method),    // compression
      uint16LE(0),uint16LE(0), // mod time/date
      uint32LE(crc),
      uint32LE(compData.length),
      uint32LE(e.data.length),
      uint16LE(nameB.length),
      uint16LE(0),         // extra length
      nameB,
      compData
    ]);

    const central = Buffer.concat([
      Buffer.from([0x50,0x4B,0x01,0x02]),
      uint16LE(20),uint16LE(20),
      uint16LE(0),
      uint16LE(method),
      uint16LE(0),uint16LE(0),
      uint32LE(crc),
      uint32LE(compData.length),
      uint32LE(e.data.length),
      uint16LE(nameB.length),
      uint16LE(0),uint16LE(0),
      uint16LE(0),uint16LE(0),
      uint32LE(0),
      uint32LE(offset),
      nameB
    ]);

    localHeaders.push(local);
    centralDirs.push(central);
    offset += local.length;
  }

  const centralBuf  = Buffer.concat(centralDirs);
  const centralSize = centralBuf.length;
  const eocd = Buffer.concat([
    Buffer.from([0x50,0x4B,0x05,0x06]),
    uint16LE(0),uint16LE(0),
    uint16LE(entries.length),
    uint16LE(entries.length),
    uint32LE(centralSize),
    uint32LE(offset),
    uint16LE(0)
  ]);

  return Buffer.concat([...localHeaders, centralBuf, eocd]);
}

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res={status:200,headers:CORS,body:'{}'}; context.done(); return; }

  const { month, year, zoneId, layout } = req.body || {};
  if (!month || !year || !zoneId || !layout) {
    context.res={status:400,headers:CORS,body:JSON.stringify({error:'Missing fields'})}; context.done(); return;
  }

  const abbr    = zoneAbbr(zoneId);
  const spreads = layout.spreads || [];
  const totalSp = spreads.length;
  const blobSvc = BlobServiceClient.fromConnectionString(STORAGE_CONN);
  const cont    = blobSvc.getContainerClient(CONTAINER);

  // Build page list
  const pages = [];
  function addPage(pageNum, slot, label) {
    if (!slot) {
      pages.push({ pageNum, path:null, note:'EMPTY' });
    } else if (slot.type === 'hp-pair') {
      const l = slot.left  ? slot.left.business  : '(empty)';
      const r = slot.right ? slot.right.business : '(empty)';
      pages.push({ pageNum, path:null, note:'HP PAIR: '+l+' | '+r+' — supply combined file', needsCombine:true });
    } else if (slot.size === '2P') {
      const v = get2PVariants(slot.path);
      pages.push({ pageNum, path:v.p2p1, note:'2P LEFT (2P1)', is2P:true, fallback:slot.path });
    } else {
      pages.push({ pageNum, path:slot.path, note:label+' — '+(slot.filename||slot.path) });
    }
  }

  for (let si = 0; si < totalSp; si++) {
    const sp = spreads[si];
    const isFC = si === 0;
    const isBP = si === totalSp - 1;
    if (isFC) {
      addPage(1, sp.left, 'FC');
    } else if (isBP) {
      addPage((totalSp-1)*2, sp.right, 'BP');
    } else {
      const pageL = si * 2, pageR = si * 2 + 1;
      if (sp.left && sp.left.size === '2P') {
        const v = get2PVariants(sp.left.path);
        pages.push({ pageNum:pageL, path:v.p2p1, note:'2P LEFT (2P1)',  is2P:true, fallback:sp.left.path });
        pages.push({ pageNum:pageR, path:v.p2p2, note:'2P RIGHT (2P2)', is2P:true, fallback:sp.left.path });
      } else {
        addPage(pageL, sp.left,  'FP left');
        addPage(pageR, sp.right, 'FP right');
      }
    }
  }

  // Build layout sheet
  let sheet = 'PRINT LAYOUT — Zone ' + zoneId + ' — ' + month + '/' + year + '\n' + '='.repeat(60) + '\n\n';
  pages.forEach(function(p) {
    sheet += pageLabel(p.pageNum).toUpperCase() + '  →  ' + abbr + '.' + pageLabel(p.pageNum) + '.pdf\n';
    sheet += '      ' + p.note + '\n\n';
  });

  try {
    const entries = [];
    entries.push({ name: abbr+'-layout-'+month+year+'.txt', data: Buffer.from(sheet,'utf8') });

    for (const p of pages) {
      const fname = abbr + '.' + pageLabel(p.pageNum) + '.pdf';
      if (!p.path) {
        const txt = p.needsCombine ? 'COMBINED FILE NEEDED\n\n'+p.note : 'PAGE EMPTY';
        entries.push({ name: fname.replace('.pdf','.MISSING.txt'), data: Buffer.from(txt,'utf8') });
        continue;
      }
      let buf = null;
      try { buf = await cont.getBlockBlobClient(p.path).downloadToBuffer(); } catch(e) {}
      if (!buf && p.fallback) {
        try { buf = await cont.getBlockBlobClient(p.fallback).downloadToBuffer(); } catch(e) {}
      }
      if (buf) {
        entries.push({ name: fname, data: buf });
        context.log('✓', fname);
      } else {
        entries.push({ name: fname.replace('.pdf','.ERROR.txt'), data: Buffer.from('FILE NOT FOUND: '+p.path,'utf8') });
      }
    }

    const zipBuf  = buildZip(entries);
    const zipName = abbr + '-layout-' + month + year + '.zip';

    context.res = {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type':        'application/zip',
        'Content-Disposition': 'attachment; filename="' + zipName + '"',
        'Content-Length':      zipBuf.length.toString()
      },
      body:  zipBuf,
      isRaw: true
    };
  } catch(e) {
    context.log.error('exportLayoutZip error:', e.message);
    context.res = { status:500, headers:CORS, body: JSON.stringify({ error: e.message }) };
  }
  context.done();
};
