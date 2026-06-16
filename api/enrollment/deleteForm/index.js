// FOLDER: api/deleteForm/index.js
// POST /api/deleteForm
// action: "soft"   → moves record to trash (default, recoverable for 60 days)
// action: "restore" → moves record back from trash to active
// action: "purge"  → permanently deletes (only if already in trash)
const { BlobServiceClient } = require("@azure/storage-blob");
const STORAGE_CONN  = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER     = "enrollments";
const TRASH_CONTAINER = "enrollments-trash";
const DASHBOARD_KEY = process.env.DASHBOARD_KEY || "changeme";
const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

module.exports = async function(context, req) {
  if (req.method === "OPTIONS") {
    context.res = { status:200, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}, body:"{}" };
    return;
  }

  // Parse body — handle both string and object
  let body = req.body || {};
  if (typeof body === "string") { try { body = JSON.parse(body); } catch(e) { body = {}; } }

  // Accept key from body OR query string
  const id     = body.id     || req.query.id;
  const key    = body.key    || req.query.key;
  const action = body.action || req.query.action;
  context.log("deleteForm:", { id, action, keyMatch: key === DASHBOARD_KEY });

  if (key !== DASHBOARD_KEY) {
    context.res = { status:401, headers:{"Content-Type":"application/json"}, body: JSON.stringify({error:"Unauthorized"}) };
    return;
  }
  if (!id) {
    context.res = { status:400, headers:{"Content-Type":"application/json"}, body: JSON.stringify({error:"Missing id"}) };
    return;
  }

  try {
    const blobSvc      = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const activeContainer = blobSvc.getContainerClient(CONTAINER);
    const trashContainer  = blobSvc.getContainerClient(TRASH_CONTAINER);

    // Ensure trash container exists
    await trashContainer.createIfNotExists();

    if (!action || action === "soft") {
      // ── SOFT DELETE: move to trash container with metadata ──────────────
      const srcBlob  = activeContainer.getBlockBlobClient(`${id}.json`);
      const destBlob = trashContainer.getBlockBlobClient(`${id}.json`);

      const dl     = await srcBlob.downloadToBuffer();
      const record = JSON.parse(dl.toString());

      // Stamp deletion info on the record
      record._deleted    = true;
      record._deletedAt  = new Date().toISOString();
      record._purgeAfter = new Date(Date.now() + SIXTY_DAYS_MS).toISOString();

      // Save to trash
      const trashData = Buffer.from(JSON.stringify(record));
      await destBlob.upload(trashData, trashData.length, {
        blobHTTPHeaders: { blobContentType: "application/json" }
      });

      // Remove from active
      await srcBlob.delete();

      context.log("Soft deleted:", id, "purge after:", record._purgeAfter);
      context.res = {
        status: 200,
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ ok:true, action:"soft", purgeAfter: record._purgeAfter })
      };

    } else if (action === "restore") {
      // ── RESTORE: move back from trash to active ──────────────────────────
      const srcBlob  = trashContainer.getBlockBlobClient(`${id}.json`);
      const destBlob = activeContainer.getBlockBlobClient(`${id}.json`);

      const dl     = await srcBlob.downloadToBuffer();
      const record = JSON.parse(dl.toString());

      // Remove deletion stamps
      delete record._deleted;
      delete record._deletedAt;
      delete record._purgeAfter;

      const restored = Buffer.from(JSON.stringify(record));
      await destBlob.upload(restored, restored.length, {
        blobHTTPHeaders: { blobContentType: "application/json" }
      });
      await srcBlob.delete();

      context.log("Restored:", id);
      context.res = {
        status: 200,
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ ok:true, action:"restore" })
      };

    } else if (action === "purge") {
      // ── PURGE: permanent delete from trash only ──────────────────────────
      const trashBlob = trashContainer.getBlockBlobClient(`${id}.json`);
      await trashBlob.delete();
      try { await trashContainer.getBlockBlobClient(`${id}_audit.json`).delete(); } catch(e){}

      context.log("Purged:", id);
      context.res = {
        status: 200,
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ ok:true, action:"purge" })
      };

    } else {
      context.res = { status:400, headers:{"Content-Type":"application/json"}, body: JSON.stringify({error:"Unknown action: "+action}) };
    }

  } catch (err) {
    context.log.error("deleteForm error:", err.message);
    context.res = {
      status: 500,
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ error: err.message })
    };
  }
};