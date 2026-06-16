// POST /api/trackOpen { id }
// Logs first open and updates last open timestamp
const { BlobServiceClient } = require("@azure/storage-blob");
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER    = "enrollments";

module.exports = async function(context, req) {
  if (req.method === "OPTIONS") { context.res={status:200}; return; }
  const id = req.body && req.body.id;
  if (!id) { context.res={status:400,body:{error:"Missing id"}}; return; }
  try {
    const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient(CONTAINER);
    const blob      = container.getBlockBlobClient(`${id}.json`);
    const dl        = await blob.downloadToBuffer();
    const record    = JSON.parse(dl.toString());

    const now = new Date().toISOString();

    // Track first open only once
    if (!record.openedAt) {
      record.openedAt = now;
      if (record.status === 'sent') record.status = 'opened';
    }
    // Always update last open
    record.lastOpenedAt = now;
    record.openCount = (record.openCount || 0) + 1;

    const updated = JSON.stringify(record);
    await blob.upload(updated, Buffer.byteLength(updated), { blobHTTPHeaders:{blobContentType:"application/json"} });
    context.res = { status:200, body:{ ok:true } };
  } catch (err) {
    context.res = { status:500, body:{ error:err.message } };
  }
};
