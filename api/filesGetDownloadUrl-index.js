// v1 - generate SAS download URL
const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER    = 'ad-proofs';

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

  const blobPath = req.query.path;
  if (!blobPath || blobPath.includes('..')) {
    context.res = { status: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid path' }) };
    context.done(); return;
  }

  try {
    const connParts = {};
    STORAGE_CONN.split(';').forEach(part => {
      const idx = part.indexOf('=');
      if (idx > -1) connParts[part.slice(0, idx)] = part.slice(idx + 1);
    });

    const accountName = connParts['AccountName'];
    const accountKey  = connParts['AccountKey'];
    const sharedKey   = new StorageSharedKeyCredential(accountName, accountKey);
    const expiresOn   = new Date(Date.now() + 15 * 60 * 1000);

    const sasToken = generateBlobSASQueryParameters(
      { containerName: CONTAINER, blobName: blobPath, permissions: BlobSASPermissions.parse('r'), expiresOn,
        contentDisposition: `attachment; filename="${blobPath.split('/').pop()}"` },
      sharedKey
    ).toString();

    const url = `https://${accountName}.blob.core.windows.net/${CONTAINER}/${blobPath}?${sasToken}`;
    context.res = { status: 200, headers: CORS, body: JSON.stringify({ url, expiresAt: expiresOn.toISOString() }) };
  } catch(e) {
    context.log.error('getDownloadUrl error:', e.message);
    context.res = { status: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
  context.done();
};
