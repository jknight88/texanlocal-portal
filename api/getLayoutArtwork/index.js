// api/getLayoutArtwork/index.js
// Bookings-driven: loads booked ads for month/zone, then looks for matching artwork
const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');
const STORAGE_CONN     = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER_FILES  = 'ad-proofs';
const CONTAINER_IMAGES = 'ad-proof-images';
const CORS = {
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers':'Content-Type,Authorization',
  'Content-Type':'application/json'
};

function parseConn() {
  const p = {};
  STORAGE_CONN.split(';').forEach(function(s){ const i=s.indexOf('='); if(i>-1) p[s.slice(0,i)]=s.slice(i+1); });
  return p;
}

function getSasUrl(acct, key, container, blobName, days) {
  const cred    = new StorageSharedKeyCredential(acct, key);
  const expires = new Date(Date.now() + days*24*60*60*1000);
  const token   = generateBlobSASQueryParameters(
    { containerName:container, blobName, permissions:BlobSASPermissions.parse('r'), expiresOn:expires }, cred
  ).toString();
  return 'https://'+acct+'.blob.core.windows.net/'+container+'/'+blobName+'?'+token;
}

// Product → size code
const PRODUCT_SIZE = {
  'Full Page':'FP', 'Half Page':'HP', 'Front Cover':'FC', 'Back Page':'BP',
  '2-Page Spread':'2P', 'Combo A':'FP', 'Combo B':'FP',
  'FC + Center Spread (Combo Month)':'FC',
  'FC + 2':'FC', 'FC + 1':'FC', 'BC+2':'BP', 'BC+1':'BP'
};

// Normalize business name for fuzzy matching
function normBiz(s) {
  return (s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
}

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res={status:200,headers:CORS,body:'{}'}; context.done(); return; }

  const month  = req.query.month || '';
  const year   = req.query.year  || '';
  const zoneId = req.query.zone  || ''; // e.g. '03-BSB' or empty for all

  if (!month || !year) {
    context.res={status:400,headers:CORS,body:JSON.stringify({error:'Missing month/year'})};
    context.done(); return;
  }

  try {
    const conn      = parseConn();
    const acct      = conn['AccountName'];
    const key       = conn['AccountKey'];
    const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const filesC    = blobSvc.getContainerClient(CONTAINER_FILES);
    const imgC      = blobSvc.getContainerClient(CONTAINER_IMAGES);
    const portalC   = blobSvc.getContainerClient('portal-data');

    const monthYear = year + '-' + month;

    // 1. Load all bookings for this month
    const bkNames = [];
    for await (const b of portalC.listBlobsFlat({ prefix:'bookings/' })) {
      if (b.name.endsWith('.json')) bkNames.push(b.name);
    }

    const bookings = [];
    const batchSize = 25;
    for (let i=0; i<bkNames.length; i+=batchSize) {
      const batch = bkNames.slice(i, i+batchSize);
      const results = await Promise.all(batch.map(async function(name) {
        try { return JSON.parse((await portalC.getBlockBlobClient(name).downloadToBuffer()).toString()); }
        catch(e) { return null; }
      }));
      results.forEach(function(b) {
        if (!b || b.monthYear !== monthYear || b.status === 'cancelled') return;
        // Filter by zone if specified
        if (zoneId) {
          const zoneNum = parseInt((b.zone||'').split('-')[0]) || 0;
          const selNum  = parseInt((zoneId||'').split('-')[0]) || 0;
          if (zoneNum && selNum && zoneNum !== selNum) return;
        }
        bookings.push(b);
      });
    }

    if (!bookings.length) {
      context.res = { status:200, headers:CORS, body: JSON.stringify({ files:[] }) };
      context.done(); return;
    }

    // 2. Load all PDF files for this month from file manager
    const prefix    = year + '/' + month + '/';
    const pdfFiles  = [];
    for await (const blob of filesC.listBlobsFlat({ prefix })) {
      const fname = blob.name.replace(prefix,'');
      if (fname.includes('/') || !fname.toLowerCase().endsWith('.pdf')) continue;
      pdfFiles.push({ blobPath: blob.name, filename: fname });
    }

    // 3. For each booking, find matching artwork
    const files = [];
    for (const bk of bookings) {
      const size    = PRODUCT_SIZE[bk.product] || 'FP';
      const bizNorm = normBiz(bk.business);

      // Find matching PDF: business name must match, size must match if parseable.
      // Filenames use format: YEAR_MONTH_BusinessName_MMDD_SIZE.pdf
      // so we search all parts for a size token, then check if the remaining joined
      // parts contain the business name (rather than assuming parts[0] is the biz).
      let matchedFile = null;
      for (const pdf of pdfFiles) {
        const noExt   = pdf.filename.replace(/\.pdf$/i,'');
        const parts   = noExt.split('_');
        const pdfSize = parts.find(function(p){ return /^(FP|HP|FC|BP|2P|2P1|2P2|QP)$/i.test(p); });

        // Join all non-size, non-date (not purely numeric) parts as the candidate biz string
        const bizParts = parts.filter(function(p){
          return !/^(FP|HP|FC|BP|2P|2P1|2P2|QP)$/i.test(p) && !/^\d{4}$/.test(p) && !/^\d{2}$/.test(p) && !/^\d{4}$/.test(p);
        });
        const pdfBizFull = normBiz(bizParts.join(''));
        const pdfBizFirst = normBiz(bizParts[0] || '');

        // Match if business name appears anywhere in the joined non-size parts
        const bizMatch = pdfBizFull && bizNorm && (
          pdfBizFull.includes(bizNorm.substring(0,6)) ||
          bizNorm.includes(pdfBizFull.substring(0,6)) ||
          pdfBizFirst.includes(bizNorm.substring(0,6)) ||
          bizNorm.includes(pdfBizFirst.substring(0,6))
        );
        const sizeMatch = !pdfSize || pdfSize.toUpperCase() === size ||
                          (size==='FC' && /^FC/i.test(pdfSize)) ||
                          (size==='BP' && /^B[PC]/i.test(pdfSize));

        if (bizMatch && sizeMatch) { matchedFile = pdf; break; }
      }

      // Find thumbnail for matched file
      let thumbUrl = null;
      if (matchedFile) {
        const candidates = [
          matchedFile.blobPath.replace(/\//g,'_').replace(/\.pdf$/i,'.jpg'),
          matchedFile.filename.replace(/\.pdf$/i,'.jpg')
        ];
        for (const c of candidates) {
          try {
            await imgC.getBlockBlobClient(c).getProperties();
            thumbUrl = getSasUrl(acct, key, CONTAINER_IMAGES, c, 7);
            break;
          } catch(e) {}
        }
      }

      files.push({
        id:        matchedFile ? matchedFile.blobPath : 'booking:'+bk.bookingId,
        filename:  matchedFile ? matchedFile.filename : bk.business+'_'+month+year.slice(2)+'_'+size+'.pdf',
        path:      matchedFile ? matchedFile.blobPath : null,
        business:  bk.business,
        size:      size,
        zoneStr:   bk.zone,
        zones:     [parseInt((bk.zone||'').split('-')[0])||0],
        thumbUrl:  thumbUrl,
        hasThumb:  !!thumbUrl,
        booked:    true,
        bookingId: bk.bookingId,
        product:   bk.product,
        noArtwork: !matchedFile,
        rate:      bk.rate,
        termIndex: bk.termIndex,
        totalTermMonths: bk.totalTermMonths
      });
    }

    context.res = { status:200, headers:CORS, body: JSON.stringify({ files }) };
  } catch(e) {
    context.log.error('getLayoutArtwork error:', e.message);
    context.res = { status:500, headers:CORS, body: JSON.stringify({ error: e.message }) };
  }
  context.done();
};
