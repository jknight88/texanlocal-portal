// api/shared/utils.js
// Shared utilities used across all API functions

const { BlobServiceClient } = require('@azure/storage-blob');
const jwt = require('jsonwebtoken');

// ─── Environment ──────────────────────────────────────────────────────────────
const STORAGE_CONN  = process.env.AZURE_STORAGE_CONNECTION_STRING;
const JWT_SECRET    = process.env.JWT_SECRET || 'change-me-in-keyvault';
const TENANT_ID     = process.env.TENANT_ID;
const CLIENT_ID     = process.env.GRAPH_CLIENT_ID;
const CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET;
const FROM_EMAIL    = process.env.REP_EMAIL || 'josh@thetexanlocal.com';
const BASE_URL      = process.env.BASE_URL  || 'https://portal.thetexanlocal.com';

// ─── Blob Storage ─────────────────────────────────────────────────────────────
function getBlobClient() {
  return BlobServiceClient.fromConnectionString(STORAGE_CONN);
}

function getContainer(name) {
  return getBlobClient().getContainerClient(name);
}

async function readBlob(container, blobName) {
  const blob = getContainer(container).getBlockBlobClient(blobName);
  const dl   = await blob.downloadToBuffer();
  return JSON.parse(dl.toString());
}

async function writeBlob(container, blobName, data) {
  const c    = getContainer(container);
  await c.createIfNotExists();
  const blob = c.getBlockBlobClient(blobName);
  const buf  = Buffer.from(JSON.stringify(data));
  await blob.upload(buf, buf.length, {
    overwrite: true,
    blobHTTPHeaders: { blobContentType: 'application/json' }
  });
}

async function deleteBlob(container, blobName) {
  await getContainer(container).getBlockBlobClient(blobName).delete();
}

async function listBlobs(container, prefix) {
  const c       = getContainer(container);
  const results = [];
  for await (const blob of c.listBlobsFlat({ prefix })) {
    results.push(blob);
  }
  return results;
}

// ─── Microsoft Graph ──────────────────────────────────────────────────────────
let _graphToken    = null;
let _graphExpiry   = 0;

async function getGraphToken() {
  if (_graphToken && Date.now() < _graphExpiry) return _graphToken;
  const params = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope:         'https://graph.microsoft.com/.default'
  });
  const res  = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params.toString()
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Graph token error: ' + JSON.stringify(data));
  _graphToken  = data.access_token;
  _graphExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return _graphToken;
}

async function sendEmail(toEmail, toName, subject, htmlBody, attachments) {
  const token = await getGraphToken();
  const message = {
    subject,
    body:         { contentType: 'HTML', content: htmlBody },
    toRecipients: [{ emailAddress: { address: toEmail, name: toName || toEmail } }],
    from:         { emailAddress: { address: FROM_EMAIL, name: 'Josh Knight — The Texan Local' } },
    replyTo:      [{ emailAddress: { address: FROM_EMAIL } }]
  };
  if (attachments && attachments.length) {
    message.attachments = attachments.map(a => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name:          a.name,
      contentType:   a.type || 'application/pdf',
      contentBytes:  a.content
    }));
  }
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${FROM_EMAIL}/sendMail`, {
    method:  'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ message, saveToSentItems: true })
  });
  if (res.status !== 202) {
    const err = await res.text();
    throw new Error('Graph sendMail error: ' + err);
  }
}

// ─── JWT Auth ─────────────────────────────────────────────────────────────────
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch(e) { return null; }
}

function getTokenFromRequest(req) {
  const auth   = req.headers && req.headers.authorization;
  const cookie = req.headers && req.headers.cookie;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  if (cookie) {
    const match = cookie.match(/txl_token=([^;]+)/);
    if (match) return match[1];
  }
  // Also accept token via query string
  if (req.query && req.query.token) return decodeURIComponent(req.query.token);
  return null;
}

function requireAuth(req, roles) {
  const token   = getTokenFromRequest(req);
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;
  if (roles && !roles.includes(payload.role)) return null;
  return payload;
}

// ─── CORS headers ─────────────────────────────────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  BASE_URL,
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Credentials': 'true',
  'Content-Type': 'application/json'
};

function corsOk(context) {
  context.res = { status: 200, headers: CORS_HEADERS, body: '{}' };
}

function ok(context, body) {
  context.res = { status: 200, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

function err(context, status, message) {
  context.res = { status, headers: CORS_HEADERS, body: JSON.stringify({ error: message }) };
}

// ─── Email HTML wrapper ───────────────────────────────────────────────────────
function emailWrapper(content, logoUrl) {
  const logo = logoUrl
    ? `<img src="${logoUrl}" alt="The Texan Local" style="height:48px;display:block">`
    : `<span style="font-family:'Georgia',serif;font-size:20px;color:#fff;font-weight:700">The Texan Local</span>`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f7fa;font-family:Arial,sans-serif">
<div style="max-width:600px;margin:0 auto">
  <div style="background:#00205B;padding:20px 28px;border-bottom:4px solid #BF0D3E">${logo}</div>
  <div style="background:#ffffff;padding:32px 28px">${content}</div>
  <div style="background:#ffffff;border-top:3px solid #BF0D3E;padding:20px 28px">
    <div style="font-size:14px;color:#1a1a2e;margin-bottom:10px"><strong>Josh Knight</strong>, Publisher</div>
    ${logo}
    <div style="font-size:13px;color:#333;margin-top:10px">Where Local Residents Find Local Businesses</div>
    <div style="font-size:13px;color:#333">Mobile: 830-214-3487</div>
  </div>
</div>
</body></html>`;
}

module.exports = {
  getBlobClient, getContainer, readBlob, writeBlob, deleteBlob, listBlobs,
  getGraphToken, sendEmail,
  signToken, verifyToken, getTokenFromRequest, requireAuth,
  corsOk, ok, err, CORS_HEADERS,
  emailWrapper,
  BASE_URL, FROM_EMAIL
};
