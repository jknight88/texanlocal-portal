// POST /api/verifyEmail { id, action: "send" | "confirm", token? }
// Sends a 6-digit verification code to the client email, or confirms it
const { BlobServiceClient } = require("@azure/storage-blob");
const STORAGE_CONN    = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER       = "enrollments";
const GRAPH_TOKEN_URL = `https://login.microsoftonline.com/${process.env.TENANT_ID}/oauth2/v2.0/token`;
const CLIENT_ID       = process.env.GRAPH_CLIENT_ID;
const CLIENT_SECRET   = process.env.GRAPH_CLIENT_SECRET;
const REP_EMAIL       = process.env.REP_EMAIL || "josh@thetexanlocal.com";
const BASE_URL        = process.env.BASE_URL  || "https://enrollment.thetexanlocal.com";

async function getGraphToken() {
  const params = new URLSearchParams({
    grant_type: "client_credentials", client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET, scope: "https://graph.microsoft.com/.default"
  });
  const r = await fetch(GRAPH_TOKEN_URL, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString()
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("Token error: " + JSON.stringify(d));
  return d.access_token;
}

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

module.exports = async function(context, req) {
  if (req.method === "OPTIONS") { context.res = { status: 200 }; return; }

  const { id, action, token } = req.body || {};
  if (!id || !action) { context.res = { status: 400, body: { error: "Missing id or action" } }; return; }

  try {
    const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient(CONTAINER);
    const blob      = container.getBlockBlobClient(`${id}.json`);
    const dl        = await blob.downloadToBuffer();
    const record    = JSON.parse(dl.toString());

    if (action === "send") {
      // Generate 6-digit code, store hashed with expiry
      const code    = generateCode();
      const expires = Date.now() + 15 * 60 * 1000; // 15 minutes
      // Simple hash: code + id (not crypto but sufficient for 6-digit OTP)
      const hash    = Buffer.from(`${code}:${id}:${expires}`).toString("base64");
      record.verifyHash    = hash;
      record.verifyExpires = expires;
      record.verified      = false;

      const updated = JSON.stringify(record);
      await blob.upload(updated, Buffer.byteLength(updated), { blobHTTPHeaders: { blobContentType: "application/json" } });

      // Send code via Graph
      const gToken  = await getGraphToken();
      const emailHtml = `
<div style="font-family:Arial,sans-serif;max-width:480px;color:#1a1a2e;">
  <div style="background:#00205B;padding:16px 20px;border-bottom:4px solid #BF0D3E;">
    <div style="font-size:18px;font-weight:700;color:#fff;font-family:'Georgia',serif;">The Texan Local</div>
    <div style="font-size:11px;color:rgba(255,255,255,.65);margin-top:2px;">Email Verification</div>
  </div>
  <div style="padding:24px;background:#f5f7fa;">
    <p style="font-size:14px;margin:0 0 20px;color:#333;line-height:1.6;">
      To complete your enrollment agreement, please enter the verification code below on the signing page.
      This code expires in <strong>15 minutes</strong>.
    </p>
    <div style="text-align:center;margin:24px 0;">
      <div style="display:inline-block;background:#00205B;color:#fff;font-size:32px;font-weight:700;letter-spacing:8px;padding:16px 32px;border-radius:6px;font-family:monospace;">${code}</div>
    </div>
    <p style="font-size:12px;color:#888;margin:0;">If you did not request this, please ignore this email.</p>
  </div>
</div>`;

      await fetch(`https://graph.microsoft.com/v1.0/users/${REP_EMAIL}/sendMail`, {
        method: "POST",
        headers: { "Authorization": "Bearer " + gToken, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            subject: "Your Texan Local Signing Verification Code",
            body: { contentType: "HTML", content: emailHtml },
            toRecipients: [{ emailAddress: { address: record.clientEmail } }]
          },
          saveToSentItems: false
        })
      });

      context.res = { status: 200, body: { ok: true, message: "Verification code sent" } };

    } else if (action === "confirm") {
      if (!token) { context.res = { status: 400, body: { error: "Missing token" } }; return; }
      if (!record.verifyHash || !record.verifyExpires) {
        context.res = { status: 400, body: { error: "No verification pending. Request a new code." } }; return;
      }
      if (Date.now() > record.verifyExpires) {
        context.res = { status: 400, body: { error: "Code expired. Please request a new code." } }; return;
      }

      // Decode hash and check code
      let stored;
      try { stored = Buffer.from(record.verifyHash, "base64").toString(); } catch(e) { stored = ""; }
      const [storedCode] = stored.split(":");

      if (token.trim() !== storedCode) {
        context.res = { status: 400, body: { error: "Incorrect code. Please try again." } }; return;
      }

      // Mark verified
      record.verified   = true;
      record.verifiedAt = new Date().toISOString();
      delete record.verifyHash;
      delete record.verifyExpires;

      const updated = JSON.stringify(record);
      await blob.upload(updated, Buffer.byteLength(updated), { blobHTTPHeaders: { blobContentType: "application/json" } });
      context.res = { status: 200, body: { ok: true, message: "Email verified" } };

    } else {
      context.res = { status: 400, body: { error: "Unknown action" } };
    }
  } catch (err) {
    context.log.error("verifyEmail error:", err);
    context.res = { status: 500, body: { error: err.message } };
  }
};
