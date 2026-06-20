const { BlobServiceClient } = require('@azure/storage-blob');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CORS = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization','Content-Type':'application/json'};

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res={status:200,headers:CORS,body:'{}'}; context.done(); return; }
  try {
    const data = req.body || {};
    const c    = BlobServiceClient.fromConnectionString(STORAGE_CONN).getContainerClient('portal-data');
    await c.createIfNotExists();
    const buf  = Buffer.from(JSON.stringify(data));
    await c.getBlockBlobClient('company-settings.json').upload(buf, buf.length, { overwrite:true, blobHTTPHeaders:{blobContentType:'application/json'} });
    context.res = { status:200, headers:CORS, body: JSON.stringify({ ok:true }) };
  } catch(e) {
    context.res = { status:500, headers:CORS, body: JSON.stringify({ error: e.message }) };
  }
  context.done();
};
