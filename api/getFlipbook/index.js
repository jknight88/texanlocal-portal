// api/getFlipbook/index.js
// Public endpoint — loads flipbook by token, checks expiry, returns page data
// No auth required — this is a public link
const { BlobServiceClient } = require('@azure/storage-blob');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER    = 'portal-data';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res={status:200,headers:CORS,body:'{}'}; context.done(); return; }

  const token = req.query.token || '';
  if (!token) {
    context.res={status:400,headers:CORS,body:JSON.stringify({error:'Missing token'})}; context.done(); return;
  }

  try {
    const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient(CONTAINER);

    // Find flipbook by searching for the token
    const names = [];
    for await (const b of container.listBlobsFlat({ prefix:'flipbooks/' })) {
      if (b.name.endsWith('.json')) names.push(b.name);
    }

    let flipbook = null;
    for (const name of names) {
      try {
        const buf = await container.getBlockBlobClient(name).downloadToBuffer();
        const fb  = JSON.parse(buf.toString());
        if (fb.token === token) { flipbook = fb; break; }
      } catch(e) {}
    }

    if (!flipbook) {
      context.res={status:404,headers:CORS,body:JSON.stringify({error:'Flipbook not found'})}; context.done(); return;
    }

    // Check expiry
    // Allow a 24-hour buffer on expiry check to handle server clock skew
    const expiresAt = flipbook.expiresAt ? new Date(flipbook.expiresAt) : null;
    if (expiresAt && expiresAt < new Date(Date.now() - 24*60*60*1000)) {
      context.res={status:410,headers:CORS,body:JSON.stringify({error:'expired',expiresAt:flipbook.expiresAt})}; context.done(); return;
    }

    // Increment view count (non-blocking)
    try {
      flipbook.viewCount = (flipbook.viewCount||0) + 1;
      flipbook.lastViewedAt = new Date().toISOString();
      const name = 'flipbooks/' + flipbook.zone.replace(/[^a-z0-9]/gi,'-') + '-' + flipbook.month + '-' + flipbook.year + '.json';
      const buf2 = Buffer.from(JSON.stringify(flipbook));
      container.getBlockBlobClient(name).upload(buf2, buf2.length, { overwrite:true, blobHTTPHeaders:{blobContentType:'application/json'} });
    } catch(e) {}

    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const moName = MONTHS[parseInt(flipbook.month)-1] || flipbook.month;

    context.res = { status:200, headers:CORS, body: JSON.stringify({
      ok: true,
      zone:        flipbook.zone,
      month:       flipbook.month,
      year:        flipbook.year,
      title:       flipbook.layoutTitle,
      monthName:   moName + ' ' + flipbook.year,
      pages:       flipbook.pages,
      expiresAt:   flipbook.expiresAt,
      viewCount:   flipbook.viewCount
    })};
  } catch(e) {
    context.log.error('getFlipbook error:', e.message);
    context.res = { status:500, headers:CORS, body: JSON.stringify({ error:e.message }) };
  }
  context.done();
};
