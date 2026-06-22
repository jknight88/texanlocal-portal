// api/deleteContract/index.js
// Deletes a contract and all its booking slots
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

  const { contractId, bookingsOnly } = req.body || {};
  if (!contractId) {
    context.res={status:400,headers:CORS,body:JSON.stringify({error:'Missing contractId'})}; context.done(); return;
  }

  try {
    const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient(CONTAINER);
    let deleted = 0;

    // Find and delete all booking slots for this contract
    const bookingNames = [];
    for await (const b of container.listBlobsFlat({ prefix:'bookings/' })) {
      if (b.name.endsWith('.json')) bookingNames.push(b.name);
    }

    // Batch fetch to find matching bookings
    const batchSize = 25;
    for (let i=0; i<bookingNames.length; i+=batchSize) {
      const batch = bookingNames.slice(i, i+batchSize);
      await Promise.all(batch.map(async function(name) {
        try {
          const buf     = await container.getBlockBlobClient(name).downloadToBuffer();
          const booking = JSON.parse(buf.toString());
          if (booking.contractId === contractId) {
            await container.getBlockBlobClient(name).delete();
            deleted++;
          }
        } catch(e) {}
      }));
    }

    // Delete contract itself (unless bookingsOnly)
    if (!bookingsOnly) {
      try {
        await container.getBlockBlobClient('contracts/'+contractId+'.json').delete();
      } catch(e) {}
    }

    context.log('deleteContract:', contractId, 'deleted', deleted, 'bookings, bookingsOnly:', !!bookingsOnly);
    context.res = { status:200, headers:CORS, body: JSON.stringify({ ok:true, deleted }) };
  } catch(e) {
    context.log.error('deleteContract error:', e.message);
    context.res = { status:500, headers:CORS, body: JSON.stringify({ error: e.message }) };
  }
  context.done();
};
