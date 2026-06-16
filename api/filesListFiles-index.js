// v1 - list files from blob storage
const { BlobServiceClient } = require('@azure/storage-blob');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER = 'ad-proofs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') {
    context.res = { status: 200, headers: CORS, body: '{}' };
    context.done(); return;
  }

  const year  = req.query.year  || new Date().getFullYear().toString();
  const month = req.query.month || String(new Date().getMonth() + 1).padStart(2, '0');
  const prefix = `${year}/${month}/`;

  try {
    const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient(CONTAINER);
    await container.createIfNotExists();

    const files = [];
    for await (const blob of container.listBlobsFlat({ prefix })) {
      const size = blob.properties.contentLength || 0;
      files.push({
        name:        blob.name.replace(prefix, ''),
        fullPath:    blob.name,
        size,
        sizeLabel:   size >= 1048576 ? (size/1048576).toFixed(1)+'MB' : Math.round(size/1024)+'KB',
        uploadedAt:  blob.properties.lastModified
      });
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    context.res = { status: 200, headers: CORS, body: JSON.stringify({ files, year, month }) };
  } catch(e) {
    context.log.error('listFiles error:', e.message);
    context.res = { status: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
  context.done();
};
