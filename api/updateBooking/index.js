// api/updateBooking/index.js — update status on a single booking slot
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
  const { bookingId, status, artworkFile, notes } = req.body || {};
  if (!bookingId) { context.res={status:400,headers:CORS,body:JSON.stringify({error:'Missing bookingId'})}; context.done(); return; }
  try {
    const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient(CONTAINER);
    const blob      = container.getBlockBlobClient('bookings/'+bookingId+'.json');
    const buf       = await blob.downloadToBuffer();
    const booking   = JSON.parse(buf.toString());
    if (status)      booking.status      = status;
    if (artworkFile) booking.artworkFile = artworkFile;
    if (notes !== undefined) booking.notes = notes;
    booking.updatedAt = new Date().toISOString();
    const newBuf = Buffer.from(JSON.stringify(booking));
    await blob.upload(newBuf, newBuf.length, { overwrite:true, blobHTTPHeaders:{blobContentType:'application/json'} });
    context.res = { status:200, headers:CORS, body: JSON.stringify({ok:true}) };
  } catch(e) {
    context.res = { status:500, headers:CORS, body: JSON.stringify({error:e.message}) };
  }
  context.done();
};
