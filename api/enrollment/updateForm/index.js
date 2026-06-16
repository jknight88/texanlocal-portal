// POST /api/updateForm { id, key, formData }
// Updates form data for an unsigned enrollment
const { BlobServiceClient } = require("@azure/storage-blob");
const STORAGE_CONN  = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER     = "enrollments";
const DASHBOARD_KEY = process.env.DASHBOARD_KEY || "changeme";

module.exports = async function(context, req) {
  if (req.method === "OPTIONS") { context.res={status:200,headers:{'Content-Type':'application/json'},body:"{}"}; return; }
  let body = req.body || {};
  if (typeof body === "string") { try { body = JSON.parse(body); } catch(e) { body = {}; } }
  const { id, key, formData } = body;
  if (key !== DASHBOARD_KEY) { context.res={status:401,headers:{'Content-Type':'application/json'},body:JSON.stringify({error:"Unauthorized"})}; return; }
  if (!id || !formData) { context.res={status:400,headers:{'Content-Type':'application/json'},body:JSON.stringify({error:"Missing id or formData"})}; return; }
  try {
    const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient(CONTAINER);
    const blob      = container.getBlockBlobClient(`${id}.json`);
    const dl        = await blob.downloadToBuffer();
    const record    = JSON.parse(dl.toString());
    if (record.status === 'signed') {
      context.res = { status:403, headers:{'Content-Type':'application/json'}, body:JSON.stringify({error:"Cannot edit a signed record."}) }; return;
    }
    record.formData   = { ...record.formData, ...formData };
    record.bizName    = formData.bizName || record.bizName;
    record.updatedAt  = new Date().toISOString();
    const updated = JSON.stringify(record);
    await blob.upload(updated, Buffer.byteLength(updated), { blobHTTPHeaders:{blobContentType:"application/json"} });
    context.res = { status:200, headers:{'Content-Type':'application/json'}, body:JSON.stringify({ok:true}) };
  } catch (err) {
    context.log.error("updateForm error:", err);
    context.res = { status:500, headers:{'Content-Type':'application/json'}, body:JSON.stringify({error:err.message}) };
  }
};
