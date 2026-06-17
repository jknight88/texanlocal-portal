// api/trackResponse/index.js
// GET /api/trackResponse?id=SESSION_ID&action=approved|changes
// Logs client response then redirects to respond page

const { BlobServiceClient } = require('@azure/storage-blob');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const BASE_URL     = process.env.BASE_URL || 'https://portal.thetexanlocal.com';
const CONTAINER    = 'ad-approvals';

module.exports = async function(context, req) {
  const sessionId = req.query.id;
  const action    = req.query.action; // 'approved' or 'changes'

  if (sessionId && (action === 'approved' || action === 'changes')) {
    try {
      const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
      const container = blobSvc.getContainerClient(CONTAINER);
      const blob      = container.getBlockBlobClient(`${sessionId}.json`);
      const dl        = await blob.downloadToBuffer();
      const record    = JSON.parse(dl.toString());

      const now = new Date().toISOString();
      record.respondedAt = now;
      record.response    = action;
      record.status      = action === 'approved' ? 'approved' : 'changes_requested';
      if (!record.openedAt) { record.openedAt = now; record.openCount = (record.openCount || 0) + 1; }

      const buf = Buffer.from(JSON.stringify(record));
      await blob.upload(buf, buf.length, { overwrite: true, blobHTTPHeaders: { blobContentType: 'application/json' } });
    } catch(e) {
      context.log.warn('trackResponse error:', e.message);
    }
  }

  // Redirect to respond page
  context.res = {
    status: 302,
    headers: { 'Location': `${BASE_URL}/respond?id=${sessionId}&action=${action}` }
  };
  context.done();
};
