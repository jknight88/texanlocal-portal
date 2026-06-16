// GET /api/getForm?id=SESSION_ID
// Returns saved form data for the signing page
const { BlobServiceClient } = require("@azure/storage-blob");
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER    = "enrollments";

module.exports = async function(context, req) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    context.res = { status: 200, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" } };
    return;
  }
  const id = req.query.id;
  if (!id) { context.res = { status: 400, headers: {"Content-Type":"application/json"}, body: JSON.stringify({ error: "Missing id" }) }; return; }
  try {
    const blobClient = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container  = blobClient.getContainerClient(CONTAINER);
    const blob       = container.getBlockBlobClient(`${id}.json`);
    const dl         = await blob.downloadToBuffer();
    const record     = JSON.parse(dl.toString());
    // Don't expose payment data to client side
    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: record.sessionId, bizName: record.bizName, clientEmail: record.clientEmail, formData: record.formData, status: record.status })
    };
  } catch (err) {
    context.log.error("getForm error:", err);
    context.res = { status: 404, headers: {"Content-Type":"application/json"}, body: JSON.stringify({ error: "Session not found" }) };
  }
};
