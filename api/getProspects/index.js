const { BlobServiceClient } = require('@azure/storage-blob');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER    = 'portal-data';
const CORS = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization','Content-Type':'application/json' };

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res = { status:200, headers:CORS, body:'{}' }; context.done(); return; }
  try {
    const blobSvc = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const c = blobSvc.getContainerClient(CONTAINER);
    await c.createIfNotExists();
    try {
      const buf = await c.getBlockBlobClient('prospects.json').downloadToBuffer();
      context.res = { status:200, headers:CORS, body: JSON.stringify({ prospects: JSON.parse(buf.toString()) }) };
    } catch(e) {
      context.res = { status:200, headers:CORS, body: JSON.stringify({ prospects: [] }) };
    }
  } catch(e) {
    context.res = { status:500, headers:CORS, body: JSON.stringify({ error: e.message }) };
  }
  context.done();
};
