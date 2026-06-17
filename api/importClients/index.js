const { BlobServiceClient } = require('@azure/storage-blob');
const { v4: uuidv4 } = require('uuid');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER = 'portal-data';
const BLOB_NAME = 'clients.json';
const CORS = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization','Content-Type':'application/json'};
module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res={status:200,headers:CORS,body:'{}'}; context.done(); return; }
  const { clients: incoming, mode } = req.body || {};
  if (!incoming || !incoming.length) { context.res={status:400,headers:CORS,body:JSON.stringify({error:'No clients provided'})}; context.done(); return; }
  try {
    const blobSvc = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient(CONTAINER);
    await container.createIfNotExists();
    const blob = container.getBlockBlobClient(BLOB_NAME);
    const now = new Date().toISOString();
    let existing = [];
    if (mode !== 'replace') { try { existing = JSON.parse((await blob.downloadToBuffer()).toString()); } catch(e) {} }
    const merged = [...existing];
    let added=0, updated=0;
    for (const c of incoming) {
      if (!c.business) continue;
      const idx = merged.findIndex(e => e.business.toLowerCase().trim() === c.business.toLowerCase().trim());
      if (idx >= 0) { merged[idx]={...merged[idx],...c,updatedAt:now}; updated++; }
      else { merged.push({...c,id:uuidv4(),createdAt:now,updatedAt:now}); added++; }
    }
    const buf = Buffer.from(JSON.stringify(merged));
    await blob.upload(buf,buf.length,{overwrite:true,blobHTTPHeaders:{blobContentType:'application/json'}});
    context.res = {status:200,headers:CORS,body:JSON.stringify({ok:true,added,updated,total:merged.length})};
  } catch(e) { context.res={status:500,headers:CORS,body:JSON.stringify({error:e.message})}; }
  context.done();
};