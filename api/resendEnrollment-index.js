// api/resendEnrollment/index.js
// POST /api/resendEnrollment { sessionId, token }
// Resends the enrollment signing email for an existing record - no new record created
const { BlobServiceClient } = require('@azure/storage-blob');
const jwt          = require('jsonwebtoken');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER    = 'enrollments';
const TENANT_ID    = process.env.TENANT_ID;
const CLIENT_ID    = process.env.GRAPH_CLIENT_ID;
const CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET;
const REP_EMAIL    = process.env.REP_EMAIL || 'josh@thetexanlocal.com';
const BASE_URL     = process.env.BASE_URL  || 'https://portal.thetexanlocal.com';
const JWT_SECRET   = process.env.JWT_SECRET || 'e42f24e9f5cfe3558144a25a0b30c6458fc4bd5ab6a6271404a1e7b509404c72';
const DASHBOARD_KEY = process.env.DASHBOARD_KEY || 'changeme';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

async function getGraphToken() {
  const params = new URLSearchParams({ grant_type:'client_credentials', client_id:CLIENT_ID, client_secret:CLIENT_SECRET, scope:'https://graph.microsoft.com/.default' });
  const res  = await fetch('https://login.microsoftonline.com/' + TENANT_ID + '/oauth2/v2.0/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:params.toString() });
  const data = await res.json();
  if (!data.access_token) throw new Error('Graph token error');
  return data.access_token;
}

async function sendEmail(toEmail, subject, html) {
  const token = await getGraphToken();
  const res = await fetch('https://graph.microsoft.com/v1.0/users/' + REP_EMAIL + '/sendMail', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'HTML', content: html },
        toRecipients: [{ emailAddress: { address: toEmail } }],
        from: { emailAddress: { address: REP_EMAIL, name: 'Josh Knight — The Texan Local' } }
      },
      saveToSentItems: true
    })
  });
  if (res.status !== 202) throw new Error('sendMail failed: ' + res.status);
}

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res = { status:200, headers:CORS, body:'{}' }; context.done(); return; }

  const body = req.body || {};
  const { sessionId, token: portalToken } = body;

  // Auth check
  let authorized = false;
  if (portalToken) {
    try { const d = jwt.verify(portalToken, JWT_SECRET); if (d.role === 'admin') authorized = true; } catch(e) {}
  }
  if (!authorized && body.key === DASHBOARD_KEY) authorized = true;
  if (!authorized) { context.res = { status:401, headers:CORS, body: JSON.stringify({ error:'Unauthorized' }) }; context.done(); return; }

  if (!sessionId) { context.res = { status:400, headers:CORS, body: JSON.stringify({ error:'Missing sessionId' }) }; context.done(); return; }

  try {
    const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient(CONTAINER);
    const blob      = container.getBlockBlobClient(sessionId + '.json');
    const buf       = await blob.downloadToBuffer();
    const record    = JSON.parse(buf.toString());

    const signLink = BASE_URL + '/sign?id=' + sessionId;
    const bizName  = record.bizName || '';
    const email    = record.clientEmail || '';

    const html = '<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">'
      + '<div style="background:#00205B;padding:20px 30px;border-bottom:4px solid #BF0D3E;">'
      + '<span style="font-family:Georgia,serif;font-size:22px;color:#fff;font-weight:700;">The Texan Local</span></div>'
      + '<div style="padding:28px 30px;">'
      + '<p style="font-size:15px;line-height:1.7;margin-bottom:16px;">Hi ' + bizName + ',</p>'
      + '<p style="font-size:15px;line-height:1.7;margin-bottom:16px;">This is a reminder that your Texan Local Advertising Agreement is ready for your review and signature.</p>'
      + '<div style="text-align:center;margin:28px 0;">'
      + '<a href="' + signLink + '" style="background:#00205B;color:#fff;padding:14px 36px;border-radius:5px;text-decoration:none;font-size:15px;font-weight:700;">Review &amp; Sign Agreement</a>'
      + '</div>'
      + '<p style="font-size:12px;color:#888;text-align:center;">If the button above does not work, copy and paste this link:<br><a href="' + signLink + '" style="color:#00205B;">' + signLink + '</a></p>'
      + '</div>'
      + '<div style="border-top:3px solid #BF0D3E;padding:20px 30px;">'
      + '<div style="font-size:14px;font-weight:700;color:#1a1a1a;">Josh Knight, Publisher</div>'
      + '<div style="font-size:13px;color:#333;">Where Local Residents Find Local Businesses</div>'
      + '<div style="font-size:13px;color:#333;">Mobile: 830-214-3487</div>'
      + '</div></body></html>';

    await sendEmail(email, 'Reminder: Your Texan Local Agreement — ' + bizName, html);

    context.res = { status:200, headers:CORS, body: JSON.stringify({ ok:true }) };
  } catch(e) {
    context.log.error('resendEnrollment error:', e.message);
    context.res = { status:500, headers:CORS, body: JSON.stringify({ error: e.message }) };
  }
  context.done();
};
