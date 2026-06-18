const { BlobServiceClient } = require('@azure/storage-blob');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER    = 'portal-data';
const CORS = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization','Content-Type':'application/json' };

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res = { status:200, headers:CORS, body:'{}' }; context.done(); return; }
  try {
    const { id } = req.body || {};
    if (!id) { context.res = { status:400, headers:CORS, body: JSON.stringify({ error:'Missing id' }) }; context.done(); return; }
    const blobSvc = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const c = blobSvc.getContainerClient(CONTAINER);
    const blob = c.getBlockBlobClient('prospects.json');
    let prospects = [];
    try { prospects = JSON.parse((await blob.downloadToBuffer()).toString()); } catch(e) {}
    prospects = prospects.filter(function(p) { return p.id !== id; });
    const buf = Buffer.from(JSON.stringify(prospects));
    await blob.upload(buf, buf.length, { overwrite:true, blobHTTPHeaders:{ blobContentType:'application/json' } });
    context.res = { status:200, headers:CORS, body: JSON.stringify({ ok:true }) };
  } catch(e) {
    context.res = { status:500, headers:CORS, body: JSON.stringify({ error: e.message }) };
  }
  context.done();
};
