// api/getBookingLog/index.js
const { BlobServiceClient } = require('@azure/storage-blob');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER    = 'portal-data';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res={status:200,headers:CORS,body:'{}'}; context.done(); return; }
  try {
    const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient(CONTAINER);
    const names = [];
    for await (const b of container.listBlobsFlat({ prefix:'booking-log/' })) {
      if (b.name.endsWith('.json')) names.push(b.name);
    }

    const entries = [];
    const batchSize = 25;
    for (let i=0; i<names.length; i+=batchSize) {
      const batch = names.slice(i, i+batchSize);
      const results = await Promise.all(batch.map(async function(name) {
        try { return JSON.parse((await container.getBlockBlobClient(name).downloadToBuffer()).toString()); }
        catch(e) { return null; }
      }));
      results.forEach(function(e){ if(e) entries.push(e); });
    }

    entries.sort(function(a,b){ return new Date(b.actionDate) - new Date(a.actionDate); });
    context.res = { status:200, headers:CORS, body: JSON.stringify({ entries }) };
  } catch(e) {
    context.res = { status:500, headers:CORS, body: JSON.stringify({ error:e.message }) };
  }
  context.done();
};
