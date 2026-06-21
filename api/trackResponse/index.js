// api/trackResponse/index.js
// Only updates record status and redirects to respond page
// Email notifications happen via submitChanges after client fills in the form
const { BlobServiceClient } = require('@azure/storage-blob');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const BASE_URL     = process.env.BASE_URL || 'https://portal.thetexanlocal.com';
const CONTAINER    = 'ad-approvals';

module.exports = async function(context, req) {
  const sessionId = req.query.id;
  const action    = req.query.action; // 'approved' or 'changes'

  let record = null;

  if (sessionId && (action === 'approved' || action === 'changes')) {
    try {
      const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
      const container = blobSvc.getContainerClient(CONTAINER);
      const blob      = container.getBlockBlobClient(sessionId + '.json');
      const dl        = await blob.downloadToBuffer();
      record = JSON.parse(dl.toString());

      const now = new Date().toISOString();
      record.respondedAt = now;
      record.response    = action;
      record.status      = action === 'approved' ? 'approved' : 'changes_requested';
      if (!record.openedAt) { record.openedAt = now; record.openCount = (record.openCount||0)+1; }

      const buf = Buffer.from(JSON.stringify(record));
      await blob.upload(buf, buf.length, {
        overwrite: true,
        blobHTTPHeaders: { blobContentType: 'application/json' }
      });
    } catch(e) {
      context.log.warn('trackResponse record update error:', e.message);
    }
  }

  // Always redirect — never return a 500 to the client
  const bizParam = record && record.business
    ? '&biz=' + encodeURIComponent(record.business)
    : '';
  context.res = {
    status: 302,
    headers: {
      'Location': BASE_URL + '/respond?id=' + sessionId + '&action=' + action + bizParam
    }
  };
  context.done();
};
