// FOLDER: api/getDashboard/index.js
// GET  /api/getDashboard?key=KEY           → list active records
// POST /api/getDashboard?key=KEY&action=soft&id=ID    → move to trash
// POST /api/getDashboard?key=KEY&action=restore&id=ID → restore from trash
// POST /api/getDashboard?key=KEY&action=purge&id=ID   → permanent delete from trash
const { BlobServiceClient } = require("@azure/storage-blob");
const STORAGE_CONN    = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER       = "enrollments";
const TRASH_CONTAINER = "enrollments-trash";
const DASHBOARD_KEY   = process.env.DASHBOARD_KEY || "changeme";
const SIXTY_DAYS_MS   = 60 * 24 * 60 * 60 * 1000;

module.exports = async function(context, req) {
  if (req.method === "OPTIONS") {
    context.res = { status:200, headers:{"Content-Type":"application/json"}, body:"{}" };
    return;
  }

  // Parse key from query or body
  let body = req.body || {};
  if (typeof body === "string") { try { body = JSON.parse(body); } catch(e) { body = {}; } }
  const key    = req.query.key    || body.key    || "";
  const action = req.query.action || body.action || "";
  const id     = req.query.id     || body.id     || "";

  if (key !== DASHBOARD_KEY) {
    context.res = { status:401, headers:{"Content-Type":"application/json"}, body: JSON.stringify({error:"Unauthorized"}) };
    return;
  }

  const blobSvc        = BlobServiceClient.fromConnectionString(STORAGE_CONN);
  const activeContainer = blobSvc.getContainerClient(CONTAINER);
  const trashContainer  = blobSvc.getContainerClient(TRASH_CONTAINER);

  // ── SOFT DELETE ────────────────────────────────────────────────────────
  if (action === "soft") {
    if (!id) { context.res={status:400,headers:{"Content-Type":"application/json"},body:JSON.stringify({error:"Missing id"})}; return; }
    try {
      await trashContainer.createIfNotExists();
      const srcBlob  = activeContainer.getBlockBlobClient(`${id}.json`);
      const destBlob = trashContainer.getBlockBlobClient(`${id}.json`);
      const dl = await srcBlob.downloadToBuffer();
      const record = JSON.parse(dl.toString());
      record._deleted    = true;
      record._deletedAt  = new Date().toISOString();
      record._purgeAfter = new Date(Date.now() + SIXTY_DAYS_MS).toISOString();
      const buf = Buffer.from(JSON.stringify(record));
      await destBlob.upload(buf, buf.length, { blobHTTPHeaders:{blobContentType:"application/json"} });
      await srcBlob.delete();
      context.res = { status:200, headers:{"Content-Type":"application/json"}, body: JSON.stringify({ok:true, action:"soft", purgeAfter:record._purgeAfter}) };
    } catch(err) {
      context.log.error("soft delete error:", err.message);
      context.res = { status:500, headers:{"Content-Type":"application/json"}, body: JSON.stringify({error:err.message}) };
    }
    return;
  }

  // ── RESTORE ────────────────────────────────────────────────────────────
  if (action === "restore") {
    if (!id) { context.res={status:400,headers:{"Content-Type":"application/json"},body:JSON.stringify({error:"Missing id"})}; return; }
    try {
      await trashContainer.createIfNotExists();
      const srcBlob  = trashContainer.getBlockBlobClient(`${id}.json`);
      const destBlob = activeContainer.getBlockBlobClient(`${id}.json`);
      const dl = await srcBlob.downloadToBuffer();
      const record = JSON.parse(dl.toString());
      delete record._deleted; delete record._deletedAt; delete record._purgeAfter;
      const buf = Buffer.from(JSON.stringify(record));
      await destBlob.upload(buf, buf.length, { blobHTTPHeaders:{blobContentType:"application/json"} });
      await srcBlob.delete();
      context.res = { status:200, headers:{"Content-Type":"application/json"}, body: JSON.stringify({ok:true, action:"restore"}) };
    } catch(err) {
      context.res = { status:500, headers:{"Content-Type":"application/json"}, body: JSON.stringify({error:err.message}) };
    }
    return;
  }

  // ── PURGE ──────────────────────────────────────────────────────────────
  if (action === "purge") {
    if (!id) { context.res={status:400,headers:{"Content-Type":"application/json"},body:JSON.stringify({error:"Missing id"})}; return; }
    try {
      await trashContainer.createIfNotExists();
      await trashContainer.getBlockBlobClient(`${id}.json`).delete();
      try { await trashContainer.getBlockBlobClient(`${id}_audit.json`).delete(); } catch(e){}
      context.res = { status:200, headers:{"Content-Type":"application/json"}, body: JSON.stringify({ok:true, action:"purge"}) };
    } catch(err) {
      context.res = { status:500, headers:{"Content-Type":"application/json"}, body: JSON.stringify({error:err.message}) };
    }
    return;
  }

  // ── UPDATE FORM ───────────────────────────────────────────────────────────
  if (action === "update") {
    let formData = body.formData || {};
    if (typeof formData === "string") { try { formData = JSON.parse(formData); } catch(e) { formData = {}; } }
    if (!id || !Object.keys(formData).length) {
      context.res = { status:400, headers:{"Content-Type":"application/json"}, body: JSON.stringify({error:"Missing id or formData"}) };
      return;
    }
    try {
      const blob   = activeContainer.getBlockBlobClient(`${id}.json`);
      const dl     = await blob.downloadToBuffer();
      const record = JSON.parse(dl.toString());
      record.formData  = Object.assign({}, record.formData, formData);
      record.bizName   = formData.bizName || record.bizName;
      record.clientEmail = formData.clientEmail || record.clientEmail;
      record.updatedAt = new Date().toISOString();
      const updated = JSON.stringify(record);
      await blob.upload(updated, Buffer.byteLength(updated), {
        overwrite: true,
        blobHTTPHeaders: { blobContentType: "application/json" }
      });
      context.res = { status:200, headers:{"Content-Type":"application/json"}, body: JSON.stringify({ok:true}) };
    } catch(err) {
      context.log.error("update error:", err.message);
      context.res = { status:500, headers:{"Content-Type":"application/json"}, body: JSON.stringify({error:err.message}) };
    }
    return;
  }

  // ── AUTO PURGE EXPIRED ────────────────────────────────────────────────
  if (action === "autopurge") {
    try {
      await trashContainer.createIfNotExists();
      const now = new Date();
      let checked=0, purged=0, kept=0;
      for await (const blob of trashContainer.listBlobsFlat()) {
        if (!blob.name.endsWith(".json") || blob.name.includes("_audit")) continue;
        checked++;
        try {
          const bc = trashContainer.getBlockBlobClient(blob.name);
          const dl = await bc.downloadToBuffer();
          const rec = JSON.parse(dl.toString());
          if (rec._purgeAfter && now >= new Date(rec._purgeAfter)) {
            await bc.delete();
            try { await trashContainer.getBlockBlobClient(blob.name.replace(".json","")+"_audit.json").delete(); } catch(e){}
            purged++;
          } else { kept++; }
        } catch(e) {}
      }
      context.res = { status:200, headers:{"Content-Type":"application/json"}, body: JSON.stringify({ok:true, checked, purged, kept}) };
    } catch(err) {
      context.res = { status:500, headers:{"Content-Type":"application/json"}, body: JSON.stringify({error:err.message}) };
    }
    return;
  }

  // ── GET TRASH LIST ─────────────────────────────────────────────────────
  if (action === "trash") {
    try {
      await trashContainer.createIfNotExists();
      const records = [];
      for await (const blob of trashContainer.listBlobsFlat()) {
        if (!blob.name.endsWith(".json") || blob.name.includes("_audit")) continue;
        try {
          const dl = await trashContainer.getBlockBlobClient(blob.name).downloadToBuffer();
          const rec = JSON.parse(dl.toString());
          const daysLeft = rec._purgeAfter ? Math.max(0, Math.ceil((new Date(rec._purgeAfter) - Date.now()) / (1000*60*60*24))) : 60;
          records.push({ sessionId:rec.sessionId, bizName:rec.bizName||"", clientEmail:rec.clientEmail||"", status:rec.status||"", rep:rec.formData?rec.formData.rep:"", monthly:rec.signed?rec.signed.monthly:"", createdAt:rec.createdAt||"", deletedAt:rec._deletedAt||"", purgeAfter:rec._purgeAfter||"", daysLeft });
        } catch(e) {}
      }
      records.sort(function(a,b){ return b.deletedAt > a.deletedAt ? 1 : -1; });
      context.res = { status:200, headers:{"Content-Type":"application/json"}, body: JSON.stringify(records) };
    } catch(err) {
      context.res = { status:500, headers:{"Content-Type":"application/json"}, body: JSON.stringify({error:err.message}) };
    }
    return;
  }

  // ── LIST ACTIVE RECORDS (default) ──────────────────────────────────────
  try {
    const results = [];
    for await (const blob of activeContainer.listBlobsFlat()) {
      if (blob.name.endsWith("_audit.json")) continue;
      try {
        const dl = await activeContainer.getBlockBlobClient(blob.name).downloadToBuffer();
        const record = JSON.parse(dl.toString());
        if (record._deleted) continue;
        results.push({
          sessionId:record.sessionId, bizName:record.bizName, clientEmail:record.clientEmail,
          status:record.status, signingMethod:record.signingMethod||'remote',
          createdAt:record.createdAt, openedAt:record.openedAt||record.lastOpenedAt||'', lastOpenedAt:record.lastOpenedAt||'',
          openCount:record.openCount||0, verifiedAt:record.verifiedAt, signedAt:record.signedAt,
          consentAt:record.signed&&record.signed.consentAt, ipAddress:record.signed&&record.signed.ipAddress,
          auditHash:record.auditHash, verified:record.verified||false,
          term:record.formData&&record.formData.term, rep:record.formData&&record.formData.rep,
          monthly:(record.signed&&record.signed.monthly)||(record.formData&&record.formData.monthly)||'',
          formData:record.formData, signed:record.signed, auditTrail:record.auditTrail
        });
      } catch(e) { context.log.warn("skip blob:", blob.name, e.message); }
    }
    results.sort(function(a,b){ return new Date(b.createdAt)-new Date(a.createdAt); });
    context.res = { status:200, headers:{"Content-Type":"application/json"}, body: JSON.stringify(results) };
  } catch(err) {
    context.log.error("getDashboard error:", err.message);
    context.res = { status:500, headers:{"Content-Type":"application/json"}, body: JSON.stringify({error:err.message}) };
  }
};
