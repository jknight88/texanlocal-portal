// FOLDER: api/getTrash/index.js
// GET /api/getTrash?key=DASHBOARD_KEY
const { BlobServiceClient } = require("@azure/storage-blob");
const STORAGE_CONN    = process.env.AZURE_STORAGE_CONNECTION_STRING;
const TRASH_CONTAINER = "enrollments-trash";
const DASHBOARD_KEY   = process.env.DASHBOARD_KEY || "changeme";

module.exports = async function(context, req) {
  if (req.method === "OPTIONS") {
    context.res = { status:200, headers:{"Content-Type":"application/json"}, body:"{}" };
    return;
  }

  const key = req.query.key || (req.body && req.body.key) || "";
  if (key !== DASHBOARD_KEY) {
    context.res = { status:401, headers:{"Content-Type":"application/json"}, body: JSON.stringify({error:"Unauthorized"}) };
    return;
  }

  try {
    const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient(TRASH_CONTAINER);
    await container.createIfNotExists();

    const records = [];
    for await (const blob of container.listBlobsFlat()) {
      if (!blob.name.endsWith(".json") || blob.name.includes("_audit")) continue;
      try {
        const bc   = container.getBlockBlobClient(blob.name);
        const dl   = await bc.downloadToBuffer();
        const rec  = JSON.parse(dl.toString());
        const daysLeft = rec._purgeAfter
          ? Math.max(0, Math.ceil((new Date(rec._purgeAfter) - Date.now()) / (1000*60*60*24)))
          : 60;
        records.push({
          sessionId:   rec.sessionId,
          bizName:     rec.bizName || "",
          clientEmail: rec.clientEmail || "",
          status:      rec.status || "",
          rep:         rec.formData ? rec.formData.rep : "",
          monthly:     rec.signed ? rec.signed.monthly : "",
          createdAt:   rec.createdAt || "",
          deletedAt:   rec._deletedAt || "",
          purgeAfter:  rec._purgeAfter || "",
          daysLeft:    daysLeft
        });
      } catch(e) { context.log.warn("skip blob", blob.name, e.message); }
    }

    // Sort by deletedAt desc
    records.sort((a,b) => (b.deletedAt > a.deletedAt ? 1 : -1));

    context.res = {
      status: 200,
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify(records)
    };
  } catch(err) {
    context.log.error("getTrash error:", err.message);
    context.res = { status:500, headers:{"Content-Type":"application/json"}, body: JSON.stringify({error:err.message}) };
  }
};