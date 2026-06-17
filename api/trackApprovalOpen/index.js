// api/trackApprovalOpen/index.js
// GET /api/trackApprovalOpen?id=SESSION_ID
// Returns 1x1 transparent GIF, updates open record

const { BlobServiceClient } = require('@azure/storage-blob');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER    = 'ad-approvals';

// 1x1 transparent GIF
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

module.exports = async function(context, req) {
  const sessionId = req.query.id;

  if (sessionId) {
    try {
      const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
      const container = blobSvc.getContainerClient(CONTAINER);
      const blob      = container.getBlockBlobClient(`${sessionId}.json`);
      const dl        = await blob.downloadToBuffer();
      const record    = JSON.parse(dl.toString());

      const now = new Date().toISOString();
      if (!record.openedAt) record.openedAt = now;
      record.lastOpenedAt = now;
      record.openCount    = (record.openCount || 0) + 1;
      if (record.status === 'sent') record.status = 'opened';

      const buf = Buffer.from(JSON.stringify(record));
      await blob.upload(buf, buf.length, { overwrite: true, blobHTTPHeaders: { blobContentType: 'application/json' } });
    } catch(e) {
      context.log.warn('trackOpen error:', e.message);
    }
  }

  context.res = {
    status: 200,
    headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache' },
    body: PIXEL,
    isRaw: true
  };
  context.done();
};
