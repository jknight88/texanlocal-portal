// POST /api/saveAndSignInPerson
// In-person signing: saves form data + signed data in one shot, emails rep + client
const { BlobServiceClient } = require("@azure/storage-blob");
const crypto              = require("crypto");
const { v4: uuidv4 }      = require("uuid");
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

function parsePayDetail(payMethod, payDetail) {
  if (!payDetail) return [];
  const parts = payDetail.split('|');
  if (payMethod && payMethod.includes('Credit Card')) {
    return [
      row('Card Type',       parts[0]||''),
      row('Card Number',     parts[1]||''),
      row('Name on Card',    parts[2]||''),
      row('Expiration',      parts[3]?parts[3].replace('Exp:',''):''),
      row('CVV',             parts[4]?parts[4].replace('CVV:',''):''),
      row('Billing Address', parts[5]?parts[5].replace('Billing:',''):'')
    ].join('');
  } else {
    return [
      row('Routing Number',  parts[0]?parts[0].replace('Routing:',''):''),
      row('Account Number',  parts[1]?parts[1].replace('Account:',''):''),
      row('Account Type',    parts[2]?parts[2].replace('Type:',''):''),
      row('Account Holder',  parts[3]?parts[3].replace('Holder:',''):'')
    ].join('');
  }
}

module.exports = async function(context, req) {
  if (req.method === "OPTIONS") { context.res={status:200}; return; }
  try {
    const body = req.body;
    if (!body || !body.formData) { context.res={status:400,body:{error:"Missing form data"}}; return; }

    const sessionId = uuidv4();
    const now       = new Date().toISOString();
    const fullIp    = (req.headers["x-forwarded-for"] || req.headers["client-ip"] || "unknown").split(",")[0].trim();
    const fd        = body.formData;

    // Build audit document
    const auditDoc = JSON.stringify({
      sessionId, bizName: fd.bizName, clientEmail: fd.clientEmail||'',
      signingMethod: "in-person",
      consentAt:   body.consentAt,
      consentText: "I agree to conduct this transaction using electronic records and signatures.",
      signedAt:    now,
      ipAddress:   fullIp,
      userAgent:   req.headers["user-agent"] || "unknown",
      payMethod:   body.payMethod,
      payDetail:   body.payDetail,
      subtotal:    body.subtotal,
      firstMonth:  body.firstMonth,
      monthly:     body.monthly,
      initials:    body.initials,
      sigName:     body.sigName,
      sigTitle:    body.sigTitle,
      formData:    fd
    });

    const auditHash = crypto.createHash("sha256").update(auditDoc).digest("hex");

    const auditTrail = [
      { event:"agreement_created",  timestamp:now, detail:"In-person enrollment — created and signed simultaneously" },
      { event:"consent_given",      timestamp:body.consentAt, ip:fullIp, detail:"Client provided electronic consent in person" },
      { event:"document_signed",    timestamp:now, ip:fullIp, detail:"Client signed in person on representative device" },
      { event:"audit_hash_created", timestamp:now, detail:"SHA-256: " + auditHash }
    ];

    const record = {
      sessionId,
      createdAt:   now,
      openedAt:    now,
      verifiedAt:  now,
      signedAt:    now,
      status:      "signed",
      signingMethod: "in-person",
      bizName:     fd.bizName,
      clientEmail: fd.clientEmail || '',
      repEmail:    REP_EMAIL,
      verified:    true,
      auditHash,
      auditTrail,
      formData:    fd,
      signed: {
        initials:    body.initials,
        payMethod:   body.payMethod,
        payDetail:   body.payDetail,
        subtotal:    body.subtotal,
        firstMonth:  body.firstMonth,
        monthly:     body.monthly,
        notes:       fd.notes || '',
        sigName:     body.sigName,
        sigTitle:    body.sigTitle,
        sigImage:    body.sigImage || '',
        repSigName:  body.repSigName  || "Josh Knight",
        repSigTitle: body.repSigTitle || "Owner",
        repSigImage: body.repSigImage || '',
        signedDate:  body.signedDate,
        consentAt:   body.consentAt,
        consentText: "I agree to conduct this transaction using electronic records and signatures.",
        ipAddress:   fullIp,
        userAgent:   req.headers["user-agent"] || "unknown",
        inPerson:    true
      }
    };

    // Set record.repSig so getPdf reads it identically to countersign flow
    record.repSig = {
      name:  body.repSigName  || "Josh Knight",
      title: body.repSigTitle || "Owner",
      image: body.repSigImage || ''
    };

    // Generate PDF token so client can access their PDF directly
    const pdfToken = require("crypto").randomBytes(24).toString("hex");
    record.pdfToken = pdfToken;
    const pdfUrl = `${BASE_URL}/api/getPdf?id=${sessionId}&pdfToken=${pdfToken}`;

    // Save to blob storage
    const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient(CONTAINER);
    await container.createIfNotExists();
    const blob      = container.getBlockBlobClient(`${sessionId}.json`);
    const updated   = JSON.stringify(record);
    await blob.upload(updated, Buffer.byteLength(updated), { blobHTTPHeaders:{blobContentType:"application/json"} });

    // Save audit log
    const auditBlob = container.getBlockBlobClient(`${sessionId}_audit.json`);
    const auditRec  = JSON.stringify({ sessionId, auditHash, auditTrail, auditDoc, createdAt:now });
    await auditBlob.upload(auditRec, Buffer.byteLength(auditRec), { blobHTTPHeaders:{blobContentType:"application/json"} });

    const token = await getGraphToken();
    const payRows = parsePayDetail(body.payMethod, body.payDetail);

    // Email to rep
    const repHtml = `
<div style="font-family:Arial,sans-serif;max-width:520px;color:#1a1a2e;">
  <div style="background:#00205B;padding:16px 22px;border-bottom:4px solid #BF0D3E;">
    <div style="font-size:18px;font-weight:700;color:#fff;font-family:'Georgia',serif;">Texan Local</div>
    <div style="font-size:11px;color:rgba(255,255,255,.65);margin-top:2px;">In-Person Enrollment — Signed</div>
  </div>
  <div style="padding:24px;background:#f5f7fa;">
    <div style="background:#1a5c1a;color:#fff;padding:14px 18px;border-radius:6px;margin-bottom:20px;">
      <div style="font-size:22px;margin-bottom:6px;">&#10003;</div>
      <div style="font-size:15px;font-weight:700;">${fd.bizName} signed in person.</div>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <tr><td style="padding:8px 10px;font-weight:700;color:#4a4f5e;background:#edf0f7;border:1px solid #c8cdd8;width:38%;">Signed By</td>
          <td style="padding:8px 10px;background:#fff;border:1px solid #c8cdd8;">${body.sigName}${body.sigTitle ? ', ' + body.sigTitle : ''}</td></tr>
      <tr><td style="padding:8px 10px;font-weight:700;color:#4a4f5e;background:#edf0f7;border:1px solid #c8cdd8;">Business</td>
          <td style="padding:8px 10px;background:#fff;border:1px solid #c8cdd8;">${fd.bizName}</td></tr>
      <tr><td style="padding:8px 10px;font-weight:700;color:#4a4f5e;background:#edf0f7;border:1px solid #c8cdd8;">Signed At</td>
          <td style="padding:8px 10px;background:#fff;border:1px solid #c8cdd8;">${new Date(now).toLocaleString("en-US",{timeZone:"America/Chicago",dateStyle:"full",timeStyle:"short"})}</td></tr>
      <tr><td style="padding:8px 10px;font-weight:700;color:#4a4f5e;background:#edf0f7;border:1px solid #c8cdd8;">Signing Method</td>
          <td style="padding:8px 10px;background:#fff;border:1px solid #c8cdd8;">In-Person</td></tr>
    </table>
    <div style="text-align:center;margin-top:20px;">
      <a href="${BASE_URL}/dashboard" style="background:#00205B;color:#fff;padding:11px 28px;border-radius:4px;text-decoration:none;font-size:13px;font-weight:700;display:inline-block;">View Full Details in Dashboard &rarr;</a>
    </div>
    <p style="font-size:11px;color:#aaa;margin-top:18px;text-align:center;">Full payment info, audit trail, and signed document available in the dashboard.</p>
  </div>
</div>`;

        await fetch(`https://graph.microsoft.com/v1.0/users/${REP_EMAIL}/sendMail`, {
      method:"POST",
      headers:{"Authorization":"Bearer "+token,"Content-Type":"application/json"},
      body: JSON.stringify({
        message:{
          subject:`\u2713 IN-PERSON SIGNED: Texan Local Enrollment \u2014 ${fd.bizName}`,
          body:{contentType:"HTML",content:repHtml},
          toRecipients:[{emailAddress:{address:REP_EMAIL}}]
        },
        saveToSentItems:true
      })
    });

    // Email copy to client with PDF link
    if (fd.clientEmail) {
      const clientHtml = `
<div style="font-family:Arial,sans-serif;max-width:580px;color:#1a1a2e;background:#ffffff;">
  <div style="background:#00205B;padding:18px 24px;border-bottom:4px solid #BF0D3E;">
    <div style="font-size:20px;font-weight:700;color:#fff;font-family:'Georgia',serif;">Texan Local</div>
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
      Hi <strong>${fd.bizName}</strong>,<br><br>
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
            subject:`Your Texan Local Enrollment Agreement is Complete - ${fd.bizName}`,
            body:{contentType:"HTML",content:clientHtml},
            toRecipients:[{emailAddress:{address:fd.clientEmail}}]
          },
          saveToSentItems:true
        })
      });
    }

    context.res = { status:200, body:{ ok:true, sessionId, auditHash } };

    // ── Auto-create booking from in-person signed enrollment (non-fatal) ──────
    try {
      const fd       = body.formData || {};
      const termStr  = (fd.term||'').toString().replace(/\s*months?/i,'').trim();
      const termNum  = parseInt(termStr) || 12;
      const formZones = fd.zones || [];

      const contractZones = formZones.filter(function(z) {
        return z.product && z.startMonth && parseFloat(z.rate||0) > 0;
      }).map(function(z) {
        return { zoneName:z.zoneName||z.id||'', product:z.product, startMonth:z.startMonth, rate:parseFloat(z.rate||0) };
      });

      if (contractZones.length) {
        const addons = [];
        if (fd.addonDetail) {
          if (/setup/i.test(fd.addonDetail))       addons.push({ name:'Setup Fee',         amount:100, type:'onetime'   });
          if (/call.?track/i.test(fd.addonDetail)) addons.push({ name:'Call Tracking',     amount:0,   type:'recurring' });
          if (/premium/i.test(fd.addonDetail))     addons.push({ name:'Premium Placement', amount:0,   type:'recurring' });
        }
        const saveRes = await fetch(`${BASE_URL}/api/saveContract`, {
          method: 'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({
            business:    fd.bizName    || '',
            contact:     fd.contact    || '',
            email:       fd.clientEmail|| '',
            phone:       fd.phone      || '',
            addr:        fd.addr       || '',
            city:        fd.city       || '',
            state:       fd.state      || 'TX',
            zip:         fd.zip        || '',
            term:        termNum,
            zones:       contractZones,
            addons:      addons,
            signedDate:  now.split('T')[0],
            firstMonth:  fd.firstMonth || '',
            monthly:     fd.monthly    || '',
            notes:       fd.notes      || '',
            rep:         fd.rep        || '',
            source:      'enrollment',
            enrollmentId: sessionId
          })
        });
        const saveData = await saveRes.json();
        if (saveData.ok) {
          context.log('Auto-created booking:', saveData.contractId, 'slots:', saveData.bookingsCreated);
          // Save contractId back to enrollment record
          record.bookingContractId = saveData.contractId;
          const updatedWithBooking = Buffer.from(JSON.stringify(record));
          await container.getBlockBlobClient(`${sessionId}.json`)
            .upload(updatedWithBooking, updatedWithBooking.length, { overwrite:true, blobHTTPHeaders:{blobContentType:'application/json'} });
        }
        else context.log.warn('saveContract failed:', saveData.error);
      }
    } catch(bookingErr) {
      context.log.warn('Auto-booking creation failed (in-person):', bookingErr.message);
    }
    // ── End auto-create booking ───────────────────────────────────────────────
  } catch (err) {
    context.log.error("saveAndSignInPerson error:", err);
    context.res = { status:500, body:{ error:err.message } };
  }
};
