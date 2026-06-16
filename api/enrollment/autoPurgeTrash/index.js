// FOLDER: api/autoPurgeTrash/index.js
// POST /api/autoPurgeTrash?key=DASHBOARD_KEY
// Permanently deletes any trash records where _purgeAfter has passed
const { BlobServiceClient } = require("@azure/storage-blob");
const STORAGE_CONN    = process.env.AZURE_STORAGE_CONNECTION_STRING;
const TRASH_CONTAINER = "enrollments-trash";
const DASHBOARD_KEY   = process.env.DASHBOARD_KEY || "changeme";

module.exports = async function(context, req) {
  if (req.method === "OPTIONS") {
    context.res = { status:200, headers:{"Content-Type":"application/json"}, body:"{}" };
    return;
  }

  // Auth check
  const key = req.query.key || (req.body && req.body.key) || "";
  if (key !== DASHBOARD_KEY) {
    context.res = { status:401, headers:{"Content-Type":"application/json"}, body: JSON.stringify({error:"Unauthorized"}) };
    return;
  }

  const now = new Date();
  context.log("autoPurgeTrash called:", now.toISOString());

  try {
    const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient(TRASH_CONTAINER);

    const exists = await container.exists();
    if (!exists) {
      context.res = { status:200, headers:{"Content-Type":"application/json"}, body: JSON.stringify({ok:true, purged:0, kept:0, message:"Trash container empty"}) };
      return;
    }

    let checked=0, purged=0, kept=0, errors=0;
    const purgedNames = [];

    for await (const blob of container.listBlobsFlat()) {
      if (!blob.name.endsWith(".json") || blob.name.includes("_audit")) continue;
      checked++;
      try {
        const bc     = container.getBlockBlobClient(blob.name);
        const dl     = await bc.downloadToBuffer();
        const record = JSON.parse(dl.toString());

        if (!record._purgeAfter) {
          // Safety: stamp a purge date if missing
          record._purgeAfter = new Date(Date.now() + 60*24*60*60*1000).toISOString();
          const updated = Buffer.from(JSON.stringify(record));
          await bc.upload(updated, updated.length, { overwrite:true, blobHTTPHeaders:{ blobContentType:"application/json" } });
          kept++;
          continue;
        }

        if (now >= new Date(record._purgeAfter)) {
          await bc.delete();
          try { await container.getBlockBlobClient(blob.name.replace(".json","")+"_audit.json").delete(); } catch(e){}
          purged++;
          purgedNames.push(record.bizName || blob.name);
        } else {
          kept++;
        }
      } catch(e) { errors++; context.log.warn("blob error:", blob.name, e.message); }
    }

    context.log(`autoPurgeTrash done — checked:${checked} purged:${purged} kept:${kept} errors:${errors}`);
    context.res = {
      status: 200,
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ ok:true, checked, purged, kept, errors, purgedNames })
    };

  } catch(err) {
    context.log.error("autoPurgeTrash error:", err.message);
    context.res = { status:500, headers:{"Content-Type":"application/json"}, body: JSON.stringify({error:err.message}) };
  }
};
