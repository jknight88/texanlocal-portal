// GET  /api/countersign?id=SESSION_ID&key=DASHBOARD_KEY  → returns session data for rep countersign page
// POST /api/countersign  { sessionId, repSigName, repSigTitle, key } → finalizes agreement, emails client PDF link
const { BlobServiceClient } = require("@azure/storage-blob");
const crypto              = require("crypto");
const STORAGE_CONN        = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER           = "enrollments";
const GRAPH_TOKEN_URL     = `https://login.microsoftonline.com/${process.env.TENANT_ID}/oauth2/v2.0/token`;
const CLIENT_ID           = process.env.GRAPH_CLIENT_ID;
const CLIENT_SECRET       = process.env.GRAPH_CLIENT_SECRET;
const REP_EMAIL           = process.env.REP_EMAIL || "josh@thetexanlocal.com";
const BASE_URL            = process.env.BASE_URL  || "https://enrollment.thetexanlocal.com";
const DASHBOARD_KEY       = process.env.DASHBOARD_KEY || "changeme";

async function getGraphToken() {
  const p = new URLSearchParams({ grant_type:"client_credentials", client_id:CLIENT_ID, client_secret:CLIENT_SECRET, scope:"https://graph.microsoft.com/.default" });
  const r = await fetch(GRAPH_TOKEN_URL, { method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"}, body:p.toString() });
  const d = await r.json();
  if (!d.access_token) throw new Error("Token error");
  return d.access_token;
}

module.exports = async function(context, req) {
  if (req.method === "OPTIONS") { context.res={status:200}; return; }

  // ── GET: Load session for countersign page ─────────────────────────
  if (req.method === "GET") {
    const id  = req.query.id;
    const key = req.query.key;
    if (!id)  { context.res={status:400,body:{error:"Missing id"}}; return; }
    // Auth: either dashboard key or a special countersign token stored on the record
    try {
      const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
      const container = blobSvc.getContainerClient(CONTAINER);
      const blob      = container.getBlockBlobClient(`${id}.json`);
      const dl        = await blob.downloadToBuffer();
      const record    = JSON.parse(dl.toString());

      // Allow access if dashboard key matches OR countersign token matches
      if (key !== DASHBOARD_KEY && key !== record.countersignToken) {
        context.res={status:401,body:{error:"Unauthorized"}}; return;
      }
      if (record.status !== "client_signed") {
        context.res={status:400,body:{error:"This agreement is not awaiting countersignature. Status: "+record.status}}; return;
      }
      context.res = {
        status:200,
        body: {
          sessionId: record.sessionId,
          bizName:   record.bizName,
          clientEmail: record.clientEmail,
          formData:  record.formData,
          signed:    record.signed,
          signedAt:  record.signedAt,
          auditHash: record.auditHash
        }
      };
    } catch(err) {
      context.log.error("countersign GET error:", err);
      context.res={status:500,body:{error:err.message}};
    }
    return;
  }

  // ── POST: Rep countersigns, finalize, email client ─────────────────
  try {
    const body = req.body;
    if (!body || !body.sessionId) { context.res={status:400,body:{error:"Missing sessionId"}}; return; }

    const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient(CONTAINER);
    const blob      = container.getBlockBlobClient(`${body.sessionId}.json`);
    const dl        = await blob.downloadToBuffer();
    const record    = JSON.parse(dl.toString());

    // Accept dashboard key OR the countersign token stored on the record
    const isAuthorized = (body.key === DASHBOARD_KEY) || (body.key && body.key === record.countersignToken);
    if (!isAuthorized) {
      context.res={status:401,body:{error:"Unauthorized"}}; return;
    }

    if (record.status !== "client_signed") {
      context.res={status:400,body:{error:"Agreement not awaiting countersignature. Status: "+record.status}}; return;
    }

    const now = new Date().toISOString();
    record.status           = "signed";
    record.countersignedAt  = now;
    record.repSig = {
      name:  body.repSigName  || "Josh Knight",
      title: body.repSigTitle || "Owner",
      image: body.repSigImage || '',
      date:  now
    };

    // Update audit trail
    if (!record.auditTrail) record.auditTrail = [];
    record.auditTrail.push({
      event:     "countersigned",
      timestamp: now,
      detail:    "Agreement countersigned by representative: " + (body.repSigName||"Josh Knight")
    });

    // Add pdfToken then do single save
    const pdfToken = require("crypto").randomBytes(24).toString("hex");
    record.pdfToken = pdfToken;
    const updated = JSON.stringify(record);
    await blob.upload(updated, Buffer.byteLength(updated), { blobHTTPHeaders:{blobContentType:"application/json"} });

    // ── Auto-create booking from signed enrollment ────────────────────────────
    try {
      const termStr  = (record.term||'').toString().replace(/\s*months?/i,'').trim();
      const termNum  = parseInt(termStr) || 12;
      const formZones = (record.formData && record.formData.zones) ? record.formData.zones : (record.zones||[]);

      // Normalize zones to saveContract format
      const contractZones = formZones.filter(function(z) {
        return z.product && z.startMonth && parseFloat(z.rate||0) > 0;
      }).map(function(z) {
        return {
          zoneName:   z.zoneName || z.id || '',
          product:    z.product,
          startMonth: z.startMonth,
          rate:       parseFloat(z.rate||0)
        };
      });

      if (contractZones.length) {
        // Build addons from formData
        const addons = [];
        if (record.formData && record.formData.addonDetail) {
          const detail = record.formData.addonDetail;
          if (/setup/i.test(detail))     addons.push({ name:'Setup Fee',         amount:100,  type:'onetime'   });
          if (/call.?track/i.test(detail)) addons.push({ name:'Call Tracking',   amount:0,    type:'recurring' });
          if (/premium/i.test(detail))   addons.push({ name:'Premium Placement', amount:0,    type:'recurring' });
        }

        const contractPayload = {
          business:   record.bizName    || '',
          contact:    record.formData   ? (record.formData.contact    || '') : '',
          email:      record.clientEmail || record.formData ? (record.formData.clientEmail||'') : '',
          phone:      record.formData   ? (record.formData.phone      || '') : '',
          addr:       record.formData   ? (record.formData.addr       || '') : '',
          city:       record.formData   ? (record.formData.city       || '') : '',
          state:      record.formData   ? (record.formData.state      || 'TX') : 'TX',
          zip:        record.formData   ? (record.formData.zip        || '') : '',
          term:       termNum,
          zones:      contractZones,
          addons:     addons,
          signedDate: now.split('T')[0],
          firstMonth: record.formData   ? (record.formData.firstMonth || '') : '',
          monthly:    record.formData   ? (record.formData.monthly    || '') : '',
          notes:      record.formData   ? (record.formData.notes      || '') : '',
          rep:        record.formData   ? (record.formData.rep        || '') : '',
          source:     'enrollment',
          enrollmentId: body.sessionId
        };

        const saveRes = await fetch(`${BASE_URL}/api/saveContract`, {
          method:  'POST',
          headers: { 'Content-Type':'application/json' },
          body:    JSON.stringify(contractPayload)
        });
        const saveData = await saveRes.json();
        if (saveData.ok) {
          record.bookingContractId = saveData.contractId;
          context.log('Auto-created booking:', saveData.contractId, 'slots:', saveData.bookingsCreated);
          // Save record again with contractId reference
          const updated2 = JSON.stringify(record);
          await blob.upload(updated2, Buffer.byteLength(updated2), { blobHTTPHeaders:{blobContentType:"application/json"} });
        } else {
          context.log.warn('saveContract failed:', saveData.error);
        }
      }
    } catch(bookingErr) {
      // Non-fatal — log but don't fail the countersign
      context.log.warn('Auto-booking creation failed:', bookingErr.message);
    }
    // ── End auto-create booking ───────────────────────────────────────────────
    const pdfUrl = `${BASE_URL}/api/getPdf?id=${body.sessionId}&pdfToken=${pdfToken}`;
    const token  = await getGraphToken();

    // Email client with completion notice + PDF link
    const clientHtml = `
<div style="font-family:Arial,sans-serif;max-width:580px;color:#1a1a2e;background:#ffffff;">
  <div style="background:#00205B;padding:18px 24px;border-bottom:4px solid #BF0D3E;">
    <div style="font-size:20px;font-weight:700;color:#fff;font-family:'Georgia',serif;">The Texan Local</div>
    <div style="font-size:11px;color:rgba(255,255,255,.65);margin-top:2px;">Your Enrollment Agreement is Fully Executed</div>
  </div>
  <div style="padding:24px;background:#ffffff;">
    <div style="background:#ffffff;border:2px solid #2a7a2a;border-radius:6px;padding:14px 18px;margin-bottom:20px;">
      <table cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="vertical-align:middle;padding-right:10px;font-size:22px;color:#2a7a2a;font-weight:700;line-height:1;">&#10003;</td>
        <td style="vertical-align:middle;font-size:15px;font-weight:700;color:#00205B;">Your Texan Local Advertising Enrollment Agreement is complete!</td>
      </tr></table>
    </div>
    <p style="font-size:13px;line-height:1.6;color:#333;margin:0 0 16px;">
      Hi <strong>${record.bizName}</strong>,<br><br>
      Your Texan Local Advertising Enrollment Agreement is now complete. Click the button below to view and save your signed copy. Thank you again and welcome to the Texan Local Family!
    </p>
    <div style="text-align:center;margin:24px 0;">
      <a href="${pdfUrl}" style="display:inline-block;background:#00205B;color:#fff;padding:14px 32px;border-radius:5px;text-decoration:none;font-size:14px;font-weight:700;">
        &#128438; View &amp; Save Your Signed Agreement
      </a>
    </div>
    <p style="font-size:11px;color:#aaa;text-align:center;margin-top:16px;">
      Questions? Contact us at <a href="mailto:${REP_EMAIL}" style="color:#00205B;">${REP_EMAIL}</a>
    </p>
  </div>
</div>`;

    await fetch(`https://graph.microsoft.com/v1.0/users/${REP_EMAIL}/sendMail`, {
      method:"POST",
      headers:{"Authorization":"Bearer "+token,"Content-Type":"application/json"},
      body: JSON.stringify({
        message:{
          subject: `Your Texan Local Enrollment Agreement is Complete - ${record.bizName}`,
          body:{contentType:"HTML", content:clientHtml},
          toRecipients:[{emailAddress:{address:record.clientEmail}}]
        },
        saveToSentItems:true
      })
    });

    // Also notify rep
    const repHtml = `
<div style="font-family:Arial,sans-serif;max-width:480px;">
  <div style="background:#00205B;padding:14px 20px;border-bottom:4px solid #BF0D3E;">
    <div style="font-size:16px;font-weight:700;color:#fff;">The Texan Local</div>
  </div>
  <div style="padding:20px;background:#f5f7fa;">
    <div style="background:#1a5c1a;color:#fff;padding:10px 14px;border-radius:5px;font-size:13px;font-weight:700;margin-bottom:14px;">
      &#10003; Agreement fully executed - ${record.bizName}
    </div>
    <p style="font-size:12px;color:#333;">Both parties have signed. Client has been emailed their completed copy.</p>
    <div style="margin-top:14px;">
      <a href="${pdfUrl}" style="background:#00205B;color:#fff;padding:9px 18px;border-radius:4px;text-decoration:none;font-size:12px;font-weight:700;display:inline-block;margin-right:8px;">View PDF</a>
      <a href="${BASE_URL}/dashboard" style="background:#555;color:#fff;padding:9px 18px;border-radius:4px;text-decoration:none;font-size:12px;font-weight:700;display:inline-block;">Dashboard</a>
    </div>
  </div>
</div>`;

    await fetch(`https://graph.microsoft.com/v1.0/users/${REP_EMAIL}/sendMail`, {
      method:"POST",
      headers:{"Authorization":"Bearer "+token,"Content-Type":"application/json"},
      body: JSON.stringify({
        message:{
          subject: `Fully Executed: Texan Local Enrollment - ${record.bizName}`,
          body:{contentType:"HTML", content:repHtml},
          toRecipients:[{emailAddress:{address:REP_EMAIL}}]
        },
        saveToSentItems:true
      })
    });

    context.res = { status:200, body:{ ok:true, pdfUrl } };
  } catch(err) {
    context.log.error("countersign POST error:", err);
    context.res = { status:500, body:{error:err.message} };
  }
};
