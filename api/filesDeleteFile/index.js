// v1 - delete file from blob storage
const { BlobServiceClient } = require('@azure/storage-blob');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER    = 'ad-proofs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') {
    context.res = { status: 200, headers: CORS, body: '{}' };
    context.done(); return;
  }

  const blobPath = req.query.path || (req.body && req.body.path);
  if (!blobPath || blobPath.includes('..')) {
    context.res = { status: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid path' }) };
    context.done(); return;
  }

  try {
    const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient(CONTAINER);
    await container.getBlockBlobClient(blobPath).delete();
    context.res = { status: 200, headers: CORS, body: JSON.stringify({ ok: true, deleted: blobPath }) };
  } catch(e) {
    context.log.error('deleteFile error:', e.message);
    context.res = { status: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
  context.done();
};
