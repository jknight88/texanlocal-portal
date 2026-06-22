// api/getContracts/index.js
// Returns all contracts, optionally filtered by status
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
  const status = req.query.status || '';
  try {
    const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient(CONTAINER);
    await container.createIfNotExists();

    const names = [];
    for await (const b of container.listBlobsFlat({ prefix:'contracts/' })) {
      if (b.name.endsWith('.json')) names.push(b.name);
    }

    const contracts = [];
    const batchSize = 20;
    for (let i=0; i<names.length; i+=batchSize) {
      const batch = names.slice(i, i+batchSize);
      const results = await Promise.all(batch.map(async function(name) {
        try {
          const buf = await container.getBlockBlobClient(name).downloadToBuffer();
          return JSON.parse(buf.toString());
        } catch(e) { return null; }
      }));
      results.forEach(function(c) {
        if (!c) return;
        if (status && c.status !== status) return;
        contracts.push(c);
      });
    }

    contracts.sort(function(a,b){ return new Date(b.createdAt) - new Date(a.createdAt); });
    context.res = { status:200, headers:CORS, body: JSON.stringify({ contracts }) };
  } catch(e) {
    context.log.error('getContracts error:', e.message);
    context.res = { status:500, headers:CORS, body: JSON.stringify({ error: e.message }) };
  }
  context.done();
};
