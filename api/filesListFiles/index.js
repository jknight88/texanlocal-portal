const { BlobServiceClient } = require('@azure/storage-blob');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER    = 'ad-proofs';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res = { status:200, headers:CORS, body:'{}' }; context.done(); return; }

  const year  = req.query.year  || new Date().getFullYear().toString();
  const month = req.query.month || String(new Date().getMonth()+1).padStart(2,'0');
  const prefix = year + '/' + month + '/';

  try {
    const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient(CONTAINER);
    await container.createIfNotExists();

    const files = [];
    for await (const blob of container.listBlobsFlat({ prefix })) {
      const name = blob.name.replace(prefix, '');
      // Skip subfolders (previews/, etc)
      if (name.includes('/')) continue;
      // Skip non-PDF files
      if (!name.toLowerCase().endsWith('.pdf')) continue;
      files.push({
        name,
        fullPath:   blob.name,
        size:       blob.properties.contentLength,
        sizeLabel:  formatSize(blob.properties.contentLength),
        uploadedAt: blob.properties.lastModified,
        contentType: blob.properties.contentType || 'application/pdf'
      });
    }

    files.sort(function(a,b){ return a.name.localeCompare(b.name); });
    context.res = { status:200, headers:CORS, body: JSON.stringify({ files, year, month }) };
  } catch(e) {
    context.res = { status:500, headers:CORS, body: JSON.stringify({ error: e.message }) };
  }
  context.done();
};

function formatSize(bytes) {
  if (!bytes) return '—';
  const mb = bytes / (1024*1024);
  return mb >= 1 ? mb.toFixed(1)+'MB' : Math.round(bytes/1024)+'KB';
}
