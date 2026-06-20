// api/getApprovalsDashboard/index.js
// GET /api/getApprovalsDashboard?month=07&year=2026

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

  const month = req.query.month;
  const year  = req.query.year;

  try {
    const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient(CONTAINER);
    await container.createIfNotExists();

    const records = [];
    for await (const blob of container.listBlobsFlat()) {
      if (!blob.name.endsWith('.json')) continue;
      try {
        const dl     = await container.getBlockBlobClient(blob.name).downloadToBuffer();
        const record = JSON.parse(dl.toString());
        // Filter by month/year if provided
        if (month && year && month !== '') {
          if (record.mailingMonth !== String(month).padStart(2,'0') || record.mailingYear !== String(year)) continue;
        }
        records.push(record);
      } catch(e) {}
    }

    records.sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt));
    context.res = { status: 200, headers: CORS, body: JSON.stringify({ records }) };
  } catch(e) {
    context.log.error('getApprovalsDashboard error:', e.message);
    context.res = { status: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
  context.done();
};
