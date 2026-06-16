const { BlobServiceClient } = require("@azure/storage-blob");
const crypto              = require("crypto");
const STORAGE_CONN        = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER           = "enrollments";
const GRAPH_TOKEN_URL     = `https://login.microsoftonline.com/${process.env.TENANT_ID}/oauth2/v2.0/token`;
const CLIENT_ID           = process.env.GRAPH_CLIENT_ID;
const CLIENT_SECRET       = process.env.GRAPH_CLIENT_SECRET;
const REP_EMAIL           = process.env.REP_EMAIL || "josh@thetexanlocal.com";
const BASE_URL            = process.env.BASE_URL  || "https://enrollment.thetexanlocal.com";

async function getGraphToken() {
  const p = new URLSearchParams({ grant_type:"client_credentials", client_id:CLIENT_ID, client_secret:CLIENT_SECRET, scope:"https://graph.microsoft.com/.default" });
  const r = await fetch(GRAPH_TOKEN_URL, { method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"}, body:p.toString() });
  const d = await r.json(); if (!d.access_token) throw new Error("Token error"); return d.access_token;
}

function row(label, val) {
  return `<tr><td style="padding:6px 10px;font-weight:700;color:#4a4f5e;background:#edf0f7;border:1px solid #c8cdd8;width:36%;">${label}</td><td style="padding:6px 10px;background:#fff;border:1px solid #c8cdd8;">${val||'&mdash;'}</td></tr>`;
}

// Parse pipe-delimited payment detail into readable format
function parsePayDetail(payMethod, payDetail) {
  if (!payDetail) return { display: payDetail, secure: payDetail };
  const parts = payDetail.split('|');
  if (payMethod && payMethod.includes('Credit Card')) {
    // ctype|fullnum|name|Exp:MM/YYYY|CVV:xxx|Billing:addr zip
    const ctype   = parts[0] || '';
    const fullnum = parts[1] || '';
    const name    = parts[2] || '';
    const exp     = parts[3] ? parts[3].replace('Exp:','') : '';
    const cvv     = parts[4] ? parts[4].replace('CVV:','') : '';
    const billing = parts[5] ? parts[5].replace('Billing:','') : '';
    return {
      display: `${ctype} ${fullnum} | Name: ${name} | Exp: ${exp} | CVV: ${cvv} | Billing: ${billing}`,
      rows: [
        row('Card Type', ctype),
        row('Card Number', fullnum),
        row('Name on Card', name),
        row('Expiration', exp),
        row('CVV', cvv),
        row('Billing Address', billing)
      ]
    };
  } else {
    // Routing:xxx|Account:xxx|Type:xxx|Holder:xxx
    const routing = parts[0] ? parts[0].replace('Routing:','') : '';
    const account = parts[1] ? parts[1].replace('Account:','') : '';
    const type    = parts[2] ? parts[2].replace('Type:','') : '';
    const holder  = parts[3] ? parts[3].replace('Holder:','') : '';
    return {
      display: `Routing: ${routing} | Account: ${account} | Type: ${type} | Holder: ${holder}`,
      rows: [
        row('Routing Number', routing),
        row('Account Number', account),
        row('Account Type', type),
        row('Account Holder', holder)
      ]
    };
  }
}

module.exports = async function(context, req) {
  if (req.method === "OPTIONS") { context.res={status:200}; return; }
  try {
    const body = req.body;
    if (!body || !body.sessionId) { context.res={status:400,headers:{"Content-Type":"application/json"},body:JSON.stringify({error:"Missing sessionId"})}; return; }

    const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient(CONTAINER);
    const blob      = container.getBlockBlobClient(`${body.sessionId}.json`);
    const dl        = await blob.downloadToBuffer();
    const record    = JSON.parse(dl.toString());

    if (!record.verified) {
      context.res = { status:403, headers:{"Content-Type":"application/json"}, body:JSON.stringify({error:"Email not verified."}) }; return;
    }

    const fullIp   = (req.headers["x-forwarded-for"] || req.headers["client-ip"] || "unknown").split(",")[0].trim();
    const signedAt = new Date().toISOString();

    const payInfo  = parsePayDetail(body.payMethod, body.payDetail);

    const auditDoc = JSON.stringify({
      sessionId:   body.sessionId,
      bizName:     record.bizName,
      clientEmail: record.clientEmail,
      verifiedAt:  record.verifiedAt,
      consentAt:   body.consentAt,
      consentText: "I agree to conduct this transaction using electronic records and signatures.",
      signedAt,
      ipAddress:   fullIp,
      userAgent:   req.headers["user-agent"] || "unknown",
      payMethod:   body.payMethod,
      payDetail:   body.payDetail,  // full unmasked stored in audit
      subtotal:    body.subtotal,
      firstMonth:  body.firstMonth,
      monthly:     body.monthly,
      initials:    body.initials,
      sigName:     body.sigName,
      sigTitle:    body.sigTitle,
      notes:       body.notes,
      formData:    record.formData
    });

    const auditHash = crypto.createHash("sha256").update(auditDoc).digest("hex");

    const auditTrail = [
      { event:"agreement_created", timestamp:record.createdAt,    detail:"Agreement created and sent by representative" },
      { event:"email_opened",      timestamp:record.openedAt||"", detail:"Client opened signing link" },
      { event:"email_verified",    timestamp:record.verifiedAt,   ip:fullIp, detail:"Client verified email with 6-digit code" },
      { event:"consent_given",     timestamp:body.consentAt,      ip:fullIp, detail:"Client checked electronic consent agreement" },
      { event:"document_signed",   timestamp:signedAt,            ip:fullIp, detail:"Client completed all initials and signature" },
      { event:"audit_hash",        timestamp:signedAt,            detail:"SHA-256: " + auditHash }
    ];

    // Generate a secure countersign token so only rep can access the page
    const countersignToken = require("crypto").randomBytes(32).toString("hex");
    record.status           = "client_signed";
    record.countersignToken = countersignToken;
    record.signedAt   = signedAt;
    record.auditHash  = auditHash;
    record.auditTrail = auditTrail;
    record.signed = {
      initials:    body.initials,
      payMethod:   body.payMethod,
      payDetail:   body.payDetail,   // full unmasked stored in record
      payDisplay:  payInfo.display,
      subtotal:    body.subtotal,
      firstMonth:  body.firstMonth,
      monthly:     body.monthly,
      notes:       body.notes,
      sigName:     body.sigName,
      sigTitle:    body.sigTitle,
      sigImage:    body.sigImage || '',
      signedDate:  body.signedDate,
      consentAt:   body.consentAt,
      consentText: "I agree to conduct this transaction using electronic records and signatures.",
      ipAddress:   fullIp,
      userAgent:   req.headers["user-agent"] || "unknown"
    };

    const updated = JSON.stringify(record);
    await blob.upload(updated, Buffer.byteLength(updated), { blobHTTPHeaders:{blobContentType:"application/json"} });

    const auditRecord = JSON.stringify({ sessionId:body.sessionId, auditHash, auditTrail, auditDoc, createdAt:signedAt });
    const auditBlob = container.getBlockBlobClient(`${body.sessionId}_audit.json`);
    await auditBlob.upload(auditRecord, Buffer.byteLength(auditRecord), { blobHTTPHeaders:{blobContentType:"application/json"} });

    // Build email with full payment details
    const token = await getGraphToken();
    const d = record, s = record.signed;
    const payRows = payInfo.rows ? payInfo.rows.join('') : row('Payment', payInfo.display || s.payDetail);

    const countersignUrl      = `${BASE_URL}/countersign?id=${body.sessionId}&key=${encodeURIComponent(countersignToken)}`;
    const countersignUrlHtml = `${BASE_URL}/countersign?id=${body.sessionId}&amp;key=${encodeURIComponent(countersignToken)}`;
    const emailHtml = `
<div style="font-family:Arial,sans-serif;max-width:520px;color:#1a1a2e;">
  <div style="background:#00205B;padding:18px 24px;border-bottom:4px solid #BF0D3E;">
    <div style="font-size:20px;font-weight:700;color:#fff;font-family:'Georgia',serif;">The Texan Local</div>
    <div style="font-size:11px;color:rgba(255,255,255,.65);margin-top:2px;">Action Required &mdash; Countersignature Needed</div>
  </div>
  <div style="padding:24px;background:#f5f7fa;">
    <div style="background:#dde0e6;border-left:4px solid #00205B;padding:14px 18px;border-radius:4px;margin-bottom:20px;">
      <div style="font-size:15px;font-weight:700;color:#00205B;">&#9998; ${d.bizName} has signed &mdash; your countersignature is needed</div>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px;">
      <tr><td style="padding:7px 10px;font-weight:700;background:#edf0f7;border:1px solid #c8cdd8;width:38%;">Business</td><td style="padding:7px 10px;background:#fff;border:1px solid #c8cdd8;">${d.bizName}</td></tr>
      <tr><td style="padding:7px 10px;font-weight:700;background:#edf0f7;border:1px solid #c8cdd8;">Signed By</td><td style="padding:7px 10px;background:#fff;border:1px solid #c8cdd8;">${s.sigName}${s.sigTitle ? ', ' + s.sigTitle : ''}</td></tr>
      <tr><td style="padding:7px 10px;font-weight:700;background:#edf0f7;border:1px solid #c8cdd8;">Client Signed</td><td style="padding:7px 10px;background:#fff;border:1px solid #c8cdd8;">${new Date(d.signedAt).toLocaleString("en-US",{timeZone:"America/Chicago",dateStyle:"full",timeStyle:"short"})}</td></tr>
    </table>
    <div style="text-align:center;margin:20px 0;">
      <a href="${countersignUrlHtml}" style="display:inline-block;background:#BF0D3E;color:#fff;padding:14px 32px;border-radius:5px;text-decoration:none;font-size:15px;font-weight:700;">
        &#9998; Sign &amp; Complete Agreement
      </a>
    </div>
    <p style="font-size:11px;color:#aaa;text-align:center;">This link is secure and unique to this agreement. Do not share it.</p>
  </div>
  <div style="background:#00205B;border-top:3px solid #BF0D3E;padding:8px 22px;display:flex;justify-content:space-between;align-items:center;">
    <span style="font-size:10px;color:rgba(255,255,255,.55);">The Texan Local &mdash; Knight Dynamic Solutions, LLC</span>
    <span style="font-size:10px;color:rgba(255,255,255,.55);">Comal County, TX</span>
  </div>
</div>`;


        await fetch(`https://graph.microsoft.com/v1.0/users/${REP_EMAIL}/sendMail`, {
      method:"POST",
      headers:{"Authorization":"Bearer "+token,"Content-Type":"application/json"},
      body: JSON.stringify({
        message:{
          subject:`ACTION REQUIRED: Countersignature Needed - ${d.bizName}`,
          body:{contentType:"HTML",content:emailHtml},
          toRecipients:[{emailAddress:{address:REP_EMAIL}}],
          replyTo:[{emailAddress:{address:d.clientEmail}}],
          importance:'High'
        },
        saveToSentItems:true
      })
    });

    context.res = { status:200, headers:{"Content-Type":"application/json"}, body:JSON.stringify({ ok:true, auditHash }) };
  } catch (err) {
    context.log.error("submitSigned error:", err);
    context.res = { status:500, headers:{"Content-Type":"application/json"}, body:JSON.stringify({ error:err.message }) };
  }
};
