// api/getThumbUrl/index.js
// Returns a fresh short-lived SAS URL for a thumbnail in ad-proof-images.
// Called by the layout page instead of using pre-baked SAS URLs from getLayoutArtwork,
// so thumbnails never fail due to expired or clock-skewed signatures.
const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');
const STORAGE_CONN     = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER_IMAGES = 'ad-proof-images';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Content-Type': 'application/json'
};

function parseConn() {
  const p = {};
  STORAGE_CONN.split(';').forEach(function(s) {
    const i = s.indexOf('=');
    if (i > -1) p[s.slice(0, i)] = s.slice(i + 1);
  });
  return p;
}

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res = { status:200, headers:CORS, body:'{}' }; context.done(); return; }

  // blobName = e.g. "2026_06_GearGuy_0626_FP.jpg"
  const blobName = req.query.blob;
  if (!blobName || blobName.includes('..') || blobName.includes('/')) {
    context.res = { status:400, headers:CORS, body:JSON.stringify({ error:'Invalid blob name' }) };
    context.done(); return;
  }

  try {
    const conn    = parseConn();
    const acct    = conn['AccountName'];
    const key     = conn['AccountKey'];
    const blobSvc = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const imgC    = blobSvc.getContainerClient(CONTAINER_IMAGES);

    // Verify blob exists
    try {
      await imgC.getBlockBlobClient(blobName).getProperties();
    } catch(e) {
      context.res = { status:404, headers:CORS, body:JSON.stringify({ error:'Thumbnail not found' }) };
      context.done(); return;
    }

    // Fresh SAS — 2 hours, generated right now so no clock skew issues
    const sk       = new StorageSharedKeyCredential(acct, key);
    const startsOn = new Date(Date.now() - 60 * 1000);        // 1 min in the past (clock skew buffer)
    const expiresOn = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours from now
    const token    = generateBlobSASQueryParameters(
      { containerName: CONTAINER_IMAGES, blobName, permissions: BlobSASPermissions.parse('r'), startsOn, expiresOn },
      sk
    ).toString();

    const url = 'https://' + acct + '.blob.core.windows.net/' + CONTAINER_IMAGES + '/' + blobName + '?' + token;
    context.res = { status:200, headers:CORS, body:JSON.stringify({ ok:true, url }) };
  } catch(e) {
    context.log.error('getThumbUrl error:', e.message);
    context.res = { status:500, headers:CORS, body:JSON.stringify({ error:e.message }) };
  }
  context.done();
};
