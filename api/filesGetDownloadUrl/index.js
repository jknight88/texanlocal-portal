// api/files/getDownloadUrl/index.js
// GET /api/files/download?path=2026/06/ChemDry_0626_FP.pdf
// Returns a time-limited SAS URL for downloading the file
// Auth: admin, rep, designer

const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');
const { requireAuth, corsOk, ok, err } = require('../shared/utils');

const STORAGE_CONN  = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER     = 'ad-proofs';

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { corsOk(context); return; }

  const user = requireAuth(req, ['admin', 'rep', 'designer']);
  if (!user) { err(context, 401, 'Unauthorized'); return; }

  const blobPath = req.query.path;
  if (!blobPath) { err(context, 400, 'Missing path parameter'); return; }

  // Prevent path traversal
  if (blobPath.includes('..') || blobPath.startsWith('/')) {
    err(context, 400, 'Invalid path');
    return;
  }

  try {
    // Parse connection string to get account name and key
    const connParts = {};
    STORAGE_CONN.split(';').forEach(part => {
      const idx = part.indexOf('=');
      if (idx > -1) connParts[part.slice(0, idx)] = part.slice(idx + 1);
    });

    const accountName = connParts['AccountName'];
    const accountKey  = connParts['AccountKey'];

    if (!accountName || !accountKey) {
      throw new Error('Could not parse storage credentials');
    }

    const sharedKey = new StorageSharedKeyCredential(accountName, accountKey);

    // Generate SAS token valid for 15 minutes
    const expiresOn = new Date(Date.now() + 15 * 60 * 1000);
    const sasToken  = generateBlobSASQueryParameters(
      {
        containerName: CONTAINER,
        blobName:      blobPath,
        permissions:   BlobSASPermissions.parse('r'),
        expiresOn,
        contentDisposition: `attachment; filename="${blobPath.split('/').pop()}"`
      },
      sharedKey
    ).toString();

    const url = `https://${accountName}.blob.core.windows.net/${CONTAINER}/${blobPath}?${sasToken}`;

    ok(context, { url, expiresAt: expiresOn.toISOString() });

  } catch(e) {
    context.log.error('getDownloadUrl error:', e.message);
    err(context, 500, e.message);
  }
};
