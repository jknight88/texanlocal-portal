// POST /api/saveForm
// Saves pre-filled form data and sends client a signing link via Graph API
const { BlobServiceClient } = require("@azure/storage-blob");
const { v4: uuidv4 } = require("uuid");

const STORAGE_CONN  = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER     = "enrollments";
const GRAPH_TOKEN_URL = `https://login.microsoftonline.com/${process.env.TENANT_ID}/oauth2/v2.0/token`;
const CLIENT_ID     = process.env.GRAPH_CLIENT_ID;
const CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET;
const TENANT_ID     = process.env.TENANT_ID;
const REP_EMAIL     = process.env.REP_EMAIL || "josh@thetexanlocal.com";
const BASE_URL      = process.env.BASE_URL  || "https://enrollment.thetexanlocal.com";

async function getGraphToken() {
  const params = new URLSearchParams({
    grant_type:    "client_credentials",
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope:         "https://graph.microsoft.com/.default"
  });
  const resp = await fetch(GRAPH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error("Token error: " + JSON.stringify(data));
  return data.access_token;
}

async function sendEmail(token, toEmail, subject, htmlBody) {
  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/users/${REP_EMAIL}/sendMail`,
    {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type":  "application/json"
      },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: "HTML", content: htmlBody },
          toRecipients: [{ emailAddress: { address: toEmail } }]
        },
        saveToSentItems: true
      })
    }
  );
  if (!resp.ok && resp.status !== 202) {
    const err = await resp.text();
    throw new Error("Graph sendMail error: " + err);
  }
}

module.exports = async function(context, req) {
  try {
    const body = req.body;
    if (!body || !body.clientEmail || !body.bizName) {
      context.res = { status: 400, body: { error: "Missing required fields" } };
      return;
    }

    // Generate unique session ID
    const sessionId = uuidv4();
    const now       = new Date().toISOString();

    const record = {
      sessionId,
      createdAt:   now,
      status:      "sent",       // sent | opened | signed
      openedAt:    null,
      signedAt:    null,
      bizName:     body.bizName,
      clientEmail: body.clientEmail,
      repEmail:    REP_EMAIL,
      formData:    body.formData  // pre-filled fields (no payment info at this stage)
    };

    // Save to Azure Blob Storage
    const blobClient  = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container   = blobClient.getContainerClient(CONTAINER);
    await container.createIfNotExists();
    const blob        = container.getBlockBlobClient(`${sessionId}.json`);
    await blob.upload(JSON.stringify(record), Buffer.byteLength(JSON.stringify(record)), {
      blobHTTPHeaders: { blobContentType: "application/json" }
    });

    // Get Graph token (client credentials — no user interaction needed)
    const token     = await getGraphToken();
    const signLink  = `${BASE_URL}/sign?id=${sessionId}`;

    // Email to client
    const clientHtml = `
<div style="font-family:Arial,sans-serif;max-width:600px;color:#1a1a2e;">
  <div style="background:#00205B;padding:18px 24px;border-bottom:4px solid #BF0D3E;">
    <div style="font-size:22px;font-weight:700;color:#fff;font-family:'Georgia',serif;">The Texan Local</div>
    <div style="font-size:11px;color:rgba(255,255,255,.65);margin-top:3px;">Advertising Enrollment Agreement</div>
  </div>
  <div style="padding:28px 24px;background:#f5f7fa;">
    <h2 style="font-size:18px;color:#00205B;margin:0 0 12px;">Your Agreement is Ready to Sign</h2>
    <p style="font-size:14px;line-height:1.6;margin:0 0 20px;color:#333;">
      Hi ${body.bizName},<br><br>
      Your Texan Local Advertising Enrollment Agreement has been prepared and is ready for your review and signature.
      Please click the button below to complete your enrollment.
    </p>
    <div style="text-align:center;margin:28px 0;">
      <a href="${signLink}" style="display:inline-block;background:#BF0D3E;color:#fff;padding:14px 36px;border-radius:5px;text-decoration:none;font-size:15px;font-weight:700;">
        &#9998;&nbsp; Review &amp; Sign Agreement
      </a>
    </div>
    <p style="font-size:12px;color:#888;margin:0;">
      Or copy this link: <a href="${signLink}" style="color:#00205B;">${signLink}</a>
    </p>
    <p style="font-size:11px;color:#aaa;margin-top:20px;padding-top:16px;border-top:1px solid #dde2ef;">
      This link is unique to your enrollment and will remain active. If you have questions,
      contact us at <a href="mailto:${REP_EMAIL}" style="color:#00205B;">${REP_EMAIL}</a>.
    </p>
  </div>
</div>`;

    await sendEmail(token, body.clientEmail, `Your Texan Local Enrollment Agreement — ${body.bizName}`, clientHtml);

    // Notify rep
    const repHtml = `
<div style="font-family:Arial,sans-serif;max-width:600px;color:#1a1a2e;">
  <div style="background:#00205B;padding:16px 20px;border-bottom:4px solid #BF0D3E;">
    <span style="font-size:16px;font-weight:700;color:#fff;">Texan Local — Agreement Sent</span>
  </div>
  <div style="padding:20px 24px;background:#f5f7fa;">
    <p style="font-size:13px;"><strong>Business:</strong> ${body.bizName}</p>
    <p style="font-size:13px;"><strong>Client Email:</strong> ${body.clientEmail}</p>
    <p style="font-size:13px;"><strong>Sent:</strong> ${new Date().toLocaleString("en-US",{timeZone:"America/Chicago"})}</p>
    <p style="font-size:13px;"><strong>Signing Link:</strong> <a href="${signLink}">${signLink}</a></p>
    <p style="font-size:13px;margin-top:16px;">
      <a href="${BASE_URL}/dashboard" style="background:#00205B;color:#fff;padding:9px 18px;border-radius:4px;text-decoration:none;font-size:12px;font-weight:700;">View Dashboard</a>
    </p>
  </div>
</div>`;

    await sendEmail(token, REP_EMAIL, `Agreement Sent — ${body.bizName}`, repHtml);

    context.res = { status: 200, body: { sessionId, signLink } };

  } catch (err) {
    context.log.error("saveForm error:", err);
    context.res = { status: 500, body: { error: err.message } };
  }
};
