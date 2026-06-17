// api/manualApprove/index.js
// POST /api/manualApprove  { sessionId, action: 'approved'|'changes_requested', notes }
// Allows admin to manually mark approval status from dashboard

const { BlobServiceClient } = require('@azure/storage-blob');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER    = 'ad-approvals';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res = { status: 200, headers: CORS, body: '{}' }; context.done(); return; }

  const { sessionId, action, notes } = req.body || {};
  if (!sessionId || !action) {
    context.res = { status: 400, headers: CORS, body: JSON.stringify({ error: 'Missing sessionId or action' }) };
    context.done(); return;
  }

  try {
    const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient(CONTAINER);
    const blob      = container.getBlockBlobClient(`${sessionId}.json`);
    const dl        = await blob.downloadToBuffer();
    const record    = JSON.parse(dl.toString());

    const now = new Date().toISOString();
    record.respondedAt  = now;
    record.response     = action;
    record.status       = action;
    record.manualUpdate = true;
    record.updatedAt    = now;
    if (notes) record.notes = notes;

    const buf = Buffer.from(JSON.stringify(record));
    await blob.upload(buf, buf.length, { overwrite: true, blobHTTPHeaders: { blobContentType: 'application/json' } });

    context.res = { status: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
  } catch(e) {
    context.log.error('manualApprove error:', e.message);
    context.res = { status: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
  context.done();
};
