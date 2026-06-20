const { BlobServiceClient } = require('@azure/storage-blob');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CORS = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization','Content-Type':'application/json'};

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res={status:200,headers:CORS,body:'{}'}; context.done(); return; }
  const month = req.query.month || '';
  const year  = req.query.year  || '';
  if (!month || !year) { context.res={status:400,headers:CORS,body:JSON.stringify({error:'Missing month/year'})}; context.done(); return; }
  try {
    const c    = BlobServiceClient.fromConnectionString(STORAGE_CONN).getContainerClient('portal-data');
    await c.createIfNotExists();
    const key  = 'layout-' + year + '-' + month + '.json';
    try {
      const buf  = await c.getBlockBlobClient(key).downloadToBuffer();
      context.res = { status:200, headers:CORS, body: JSON.stringify({ layout: JSON.parse(buf.toString()) }) };
    } catch(e) {
      context.res = { status:200, headers:CORS, body: JSON.stringify({ layout: {} }) };
    }
  } catch(e) {
    context.res = { status:500, headers:CORS, body: JSON.stringify({ error: e.message }) };
  }
  context.done();
};
