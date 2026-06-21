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
  if (req.method === 'OPTIONS') { context.res={status:200,headers:CORS,body:'{}'}; context.done(); return; }

  const month = req.query.month || '';
  const year  = req.query.year  || '';

  try {
    const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient(CONTAINER);
    await container.createIfNotExists();

    // List all blobs first, then fetch in parallel
    const blobNames = [];
    for await (const blob of container.listBlobsFlat()) {
      if (blob.name.endsWith('.json')) blobNames.push(blob.name);
    }

    const allRecords = [];
    // Fetch in batches of 20 in parallel
    const batchSize = 20;
    for (let i = 0; i < blobNames.length; i += batchSize) {
      const batch = blobNames.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(async function(name) {
        try {
          const dl = await container.getBlockBlobClient(name).downloadToBuffer();
          return JSON.parse(dl.toString());
        } catch(e) { return null; }
      }));
      results.forEach(function(record) {
        if (!record) return;
        if (month && year && month !== '') {
          if (record.mailingMonth !== String(month).padStart(2,'0') ||
              record.mailingYear  !== String(year)) return;
        }
        allRecords.push(record);
      });
    }

    // Deduplicate: keep only the latest record per business
    // Priority: if any record is approved/changes_requested, prefer that over sent/opened
    // Among same status, keep most recent sentAt
    const statusPriority = {
      'approved': 5,
      'changes_requested': 4,
      'opened': 3,
      'sent': 2,
      'no_file': 1,
      'none': 0
    };

    const byBusiness = {};
    allRecords.forEach(function(r) {
      const key = (r.business || '').toLowerCase().trim();
      if (!byBusiness[key]) {
        byBusiness[key] = r;
      } else {
        const existing = byBusiness[key];
        const existPri = statusPriority[existing.status] || 0;
        const newPri   = statusPriority[r.status]       || 0;
        // Prefer higher status priority, or more recent if same
        if (newPri > existPri ||
           (newPri === existPri && new Date(r.sentAt) > new Date(existing.sentAt))) {
          byBusiness[key] = r;
        }
      }
    });

    const records = Object.values(byBusiness);
    records.sort(function(a, b) { return new Date(b.sentAt) - new Date(a.sentAt); });

    context.res = { status:200, headers:CORS, body: JSON.stringify({ records }) };
  } catch(e) {
    context.log.error('getApprovalsDashboard error:', e.message);
    context.res = { status:500, headers:CORS, body: JSON.stringify({ error: e.message }) };
  }
  context.done();
};
