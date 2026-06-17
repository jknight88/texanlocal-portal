const { BlobServiceClient } = require('@azure/storage-blob');
const { v4: uuidv4 } = require('uuid');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER = 'portal-data';
const BLOB_NAME = 'clients.json';
const CORS = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization','Content-Type':'application/json'};
async function load(container) { try { const dl = await container.getBlockBlobClient(BLOB_NAME).downloadToBuffer(); return JSON.parse(dl.toString()); } catch(e) { return []; } }
async function save(container, clients) { const buf=Buffer.from(JSON.stringify(clients)); await container.getBlockBlobClient(BLOB_NAME).upload(buf,buf.length,{overwrite:true,blobHTTPHeaders:{blobContentType:'application/json'}}); }
module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res={status:200,headers:CORS,body:'{}'}; context.done(); return; }
  const { client } = req.body || {};
  if (!client || !client.business) { context.res={status:400,headers:CORS,body:JSON.stringify({error:'Missing client data'})}; context.done(); return; }
  try {
    const blobSvc = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient(CONTAINER);
    await container.createIfNotExists();
    const clients = await load(container);
    const now = new Date().toISOString();
    if (client.id) {
      const idx = clients.findIndex(c => c.id === client.id);
      if (idx >= 0) clients[idx] = {...clients[idx],...client,updatedAt:now};
      else clients.push({...client,createdAt:now,updatedAt:now});
    } else {
      clients.push({...client,id:uuidv4(),createdAt:now,updatedAt:now});
    }
    await save(container, clients);
    context.res = {status:200,headers:CORS,body:JSON.stringify({ok:true})};
  } catch(e) { context.res={status:500,headers:CORS,body:JSON.stringify({error:e.message})}; }
  context.done();
};