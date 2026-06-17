const { BlobServiceClient } = require('@azure/storage-blob');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER = 'portal-data';
const BLOB_NAME = 'clients.json';
const CORS = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization','Content-Type':'application/json'};
module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res={status:200,headers:CORS,body:'{}'}; context.done(); return; }
  const { id } = req.body || {};
  if (!id) { context.res={status:400,headers:CORS,body:JSON.stringify({error:'Missing id'})}; context.done(); return; }
  try {
    const blobSvc = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient(CONTAINER);
    const blob = container.getBlockBlobClient(BLOB_NAME);
    const clients = JSON.parse((await blob.downloadToBuffer()).toString()).filter(c => c.id !== id);
    const buf = Buffer.from(JSON.stringify(clients));
    await blob.upload(buf,buf.length,{overwrite:true,blobHTTPHeaders:{blobContentType:'application/json'}});
    context.res = {status:200,headers:CORS,body:JSON.stringify({ok:true})};
  } catch(e) { context.res={status:500,headers:CORS,body:JSON.stringify({error:e.message})}; }
  context.done();
};