// api/sendApprovals/index.js
const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');
const { v4: uuidv4 } = require('uuid');

const STORAGE_CONN  = process.env.AZURE_STORAGE_CONNECTION_STRING;
const TENANT_ID     = process.env.TENANT_ID;
const CLIENT_ID     = process.env.GRAPH_CLIENT_ID;
const CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET;
const FROM_EMAIL    = process.env.REP_EMAIL || 'josh@thetexanlocal.com';
const BASE_URL      = process.env.BASE_URL  || 'https://portal.thetexanlocal.com';
const CONTAINER_FILES     = 'ad-proofs';
const CONTAINER_APPROVALS = 'ad-approvals';
const CONTAINER_IMAGES    = 'ad-proof-images';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// ── Graph token ───────────────────────────────────────────────────────────────
let _token = null, _expiry = 0;
async function getGraphToken() {
  if (_token && Date.now() < _expiry) return _token;
  const params = new URLSearchParams({
    grant_type: 'client_credentials', client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET, scope: 'https://graph.microsoft.com/.default'
  });
  const res  = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString()
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Graph token error');
  _token = data.access_token;
  _expiry = Date.now() + (data.expires_in - 60) * 1000;
  return _token;
}

// ── Parse connection string ───────────────────────────────────────────────────
function parseConn() {
  const p = {};
  STORAGE_CONN.split(';').forEach(s => { const i = s.indexOf('='); if (i > -1) p[s.slice(0,i)] = s.slice(i+1); });
  return p;
}

// ── Get SAS URL ───────────────────────────────────────────────────────────────
function getSasUrl(accountName, accountKey, container, blobName, days) {
  const sharedKey = new StorageSharedKeyCredential(accountName, accountKey);
  const expiresOn = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const token     = generateBlobSASQueryParameters(
    { containerName: container, blobName, permissions: BlobSASPermissions.parse('r'), expiresOn },
    sharedKey
  ).toString();
  return `https://${accountName}.blob.core.windows.net/${container}/${blobName}?${token}`;
}

// ── Convert PDF to hosted image ───────────────────────────────────────────────
async function getPdfImage(filesContainer, pdfPath) {
  const conn  = parseConn();
  const acct  = conn['AccountName'];
  const key   = conn['AccountKey'];
  const blobSvc    = BlobServiceClient.fromConnectionString(STORAGE_CONN);
  const imgContainer = blobSvc.getContainerClient(CONTAINER_IMAGES);
  await imgContainer.createIfNotExists();

  // Cached image name
  const safe       = pdfPath.replace(/[^a-z0-9._-]/gi, '_').replace(/\.pdf$/i, '.png');
  const cachedName = safe;
  const cachedBlob = imgContainer.getBlockBlobClient(cachedName);

  // Check if cached image exists
  try {
    await cachedBlob.getProperties();
    // Exists — return SAS URL
    return { type: 'image', url: getSasUrl(acct, key, CONTAINER_IMAGES, cachedName, 60) };
  } catch(e) {
    // Not cached — convert now
  }

  // Get temp SAS URL for the PDF (for conversion API)
  const pdfUrl = getSasUrl(acct, key, CONTAINER_FILES, pdfPath, 1);

  // Try CloudConvert free API
  try {
    const importRes = await fetch('https://api.cloudconvert.com/v2/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9' },
      body: JSON.stringify({
        tasks: {
          'import-pdf': { operation: 'import/url', url: pdfUrl, filename: 'proof.pdf' },
          'convert': { operation: 'convert', input: 'import-pdf', output_format: 'png', pages: '1', density: 150 },
          'export': { operation: 'export/url', input: 'convert' }
        }
      })
    });
    // CloudConvert needs an API key so this will fail without one
    // Fall through to next method
  } catch(e) {}

  // Fallback — return PDF link
  return { type: 'link', url: getSasUrl(acct, key, CONTAINER_FILES, pdfPath, 30), name: pdfPath.split('/').pop() };
}

// ── Normalize business name ───────────────────────────────────────────────────
function normBiz(n) { return String(n || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// ── Find matching PDFs ────────────────────────────────────────────────────────
async function findPdfs(container, businessName, year, month) {
  const norm   = normBiz(businessName);
  const prefix = `${year}/${month}/`;
  const found  = [];
  for await (const blob of container.listBlobsFlat({ prefix })) {
    if (blob.name.includes('/previews/')) continue;
    const fname = blob.name.replace(prefix, '');
    const parts = fname.replace(/\.pdf$/i, '').split('_');
    if (normBiz(parts[0]) === norm) found.push(blob.name);
  }
  return found;
}

// ── Build email HTML ──────────────────────────────────────────────────────────
function buildEmail(client, mailingMonthLabel, deadline, items, sessionId, bodyTemplate) {
  const approveUrl = `${BASE_URL}/api/trackResponse?id=${sessionId}&action=approved`;
  const changesUrl = `${BASE_URL}/api/trackResponse?id=${sessionId}&action=changes`;
  const pixelUrl   = `${BASE_URL}/api/trackApprovalOpen?id=${sessionId}`;

  const bodyText = (bodyTemplate || '')
    .replace(/{CONTACT}/g,  client.contact || client.business)
    .replace(/{BUSINESS}/g, client.business)
    .replace(/{MONTH}/g,    mailingMonthLabel)
    .replace(/{DEADLINE}/g, deadline);

  const bodyHtml = bodyText
    ? bodyText.split('\n').map(l => l.trim()
        ? `<p style="font-family:Georgia,serif;font-size:15px;line-height:1.7;color:#1a1a1a;margin:0 0 10px">${l}</p>`
        : '<br>').join('')
    : `<p style="font-family:Georgia,serif;font-size:15px;line-height:1.7;color:#1a1a1a;margin:0 0 12px">Hi ${client.contact || client.business},</p>
       <p style="font-family:Georgia,serif;font-size:15px;line-height:1.7;color:#1a1a1a;margin:0 0 12px">Your ad proof for the <strong>${mailingMonthLabel}</strong> mailing is ready. Please review by <strong>${deadline}</strong>.</p>`;

  const proofs = items.map(item => item.type === 'image'
    ? `<div style="margin:16px 0;text-align:center"><img src="${item.url}" alt="Ad Proof" style="max-width:100%;height:auto;border:1px solid #ddd;border-radius:4px"></div>`
    : `<div style="margin:16px 0;text-align:center"><a href="${item.url}" target="_blank" style="display:inline-block;background:#f0f4ff;border:2px solid #00205B;border-radius:6px;padding:16px 32px;text-decoration:none;color:#00205B;font-family:Arial,sans-serif;font-size:14px;font-weight:700">📄 View Ad Proof</a></div>`
  ).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f7fa;font-family:Arial,sans-serif">
<div style="max-width:650px;margin:0 auto;background:#fff">
  <div style="background:#00205B;padding:20px 32px;border-bottom:4px solid #BF0D3E">
    <span style="font-family:Georgia,serif;font-size:22px;color:#fff;font-weight:700">The Texan Local</span>
  </div>
  <div style="padding:28px 32px">
    ${bodyHtml}
    ${proofs}
    <div style="text-align:center;margin:28px 0 20px">
      <a href="${approveUrl}" style="display:inline-block;background:#1a5c1a;color:#fff;padding:14px 36px;border-radius:5px;text-decoration:none;font-size:15px;font-weight:700;margin:0 8px">✓ Approve Ad</a>
      <a href="${changesUrl}" style="display:inline-block;background:#BF0D3E;color:#fff;padding:14px 36px;border-radius:5px;text-decoration:none;font-size:15px;font-weight:700;margin:0 8px">✎ Request Changes</a>
    </div>
    <p style="font-family:Georgia,serif;font-size:12px;color:#888;text-align:center;margin:0">If I don't hear back by ${deadline}, your ad will run as shown.</p>
  </div>
  <div style="border-top:3px solid #BF0D3E;padding:20px 32px">
    <div style="font-size:14px;color:#1a1a1a;margin-bottom:6px"><strong>Josh Knight</strong>, Publisher</div>
    <div style="font-size:13px;color:#333">Where Local Residents Find Local Businesses</div>
    <div style="font-size:13px;color:#333">Mobile: 830-214-3487</div>
  </div>
</div>
<img src="${pixelUrl}" width="1" height="1" style="display:none" alt="">
</body></html>`;
}

// ── Send email ────────────────────────────────────────────────────────────────
async function sendEmail(toEmail, toName, subject, html) {
  const token = await getGraphToken();
  const res   = await fetch(`https://graph.microsoft.com/v1.0/users/${FROM_EMAIL}/sendMail`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject, body: { contentType: 'HTML', content: html },
        toRecipients: [{ emailAddress: { address: toEmail, name: toName || toEmail } }],
        from: { emailAddress: { address: FROM_EMAIL, name: 'Josh Knight — The Texan Local' } },
        replyTo: [{ emailAddress: { address: FROM_EMAIL } }]
      },
      saveToSentItems: true
    })
  });
  if (res.status !== 202) throw new Error('sendMail failed: ' + await res.text());
}

// ── Save record ───────────────────────────────────────────────────────────────
async function saveRecord(blobSvc, record) {
  const c   = blobSvc.getContainerClient(CONTAINER_APPROVALS);
  await c.createIfNotExists();
  const buf = Buffer.from(JSON.stringify(record));
  await c.getBlockBlobClient(`${record.sessionId}.json`).upload(buf, buf.length, {
    overwrite: true, blobHTTPHeaders: { blobContentType: 'application/json' }
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res = { status: 200, headers: CORS, body: '{}' }; context.done(); return; }

  const missing = [];
  if (!TENANT_ID)     missing.push('TENANT_ID');
  if (!CLIENT_ID)     missing.push('GRAPH_CLIENT_ID');
  if (!CLIENT_SECRET) missing.push('GRAPH_CLIENT_SECRET');
  if (!STORAGE_CONN)  missing.push('AZURE_STORAGE_CONNECTION_STRING');
  if (missing.length) {
    context.res = { status: 500, headers: CORS, body: JSON.stringify({ error: 'Missing: ' + missing.join(', ') }) };
    context.done(); return;
  }

  const { mailingMonth, mailingYear, deadline, clients, isResend, subject: subjectTpl, bodyTemplate } = req.body || {};
  if (!mailingMonth || !mailingYear || !clients || !clients.length) {
    context.res = { status: 400, headers: CORS, body: JSON.stringify({ error: 'Missing required fields' }) };
    context.done(); return;
  }

  let lookupMonth, lookupYear;
  if (isResend) {
    lookupMonth = String(mailingMonth).padStart(2, '0');
    lookupYear  = String(mailingYear);
  } else {
    const d     = new Date(parseInt(mailingYear), parseInt(mailingMonth) - 2, 1);
    lookupMonth = String(d.getMonth() + 1).padStart(2, '0');
    lookupYear  = d.getFullYear().toString();
  }

  const mailingMonthLabel = MONTH_NAMES[parseInt(mailingMonth) - 1] + ' ' + mailingYear;
  const blobSvc           = BlobServiceClient.fromConnectionString(STORAGE_CONN);
  const filesContainer    = blobSvc.getContainerClient(CONTAINER_FILES);
  const results           = [];

  for (const client of clients) {
    try {
      const matchedFiles = await findPdfs(filesContainer, client.business, lookupYear, lookupMonth);
      if (!matchedFiles.length) {
        results.push({ business: client.business, status: 'no_file' });
        continue;
      }

      const items = [];
      for (const filePath of matchedFiles) {
        try {
          const item = await getPdfImage(filesContainer, filePath);
          items.push(item);
        } catch(e) {
          context.log.error('Image error:', filePath, e.message);
        }
      }

      if (!items.length) {
        results.push({ business: client.business, status: 'error', message: 'Could not process files' });
        continue;
      }

      const sessionId = uuidv4();
      const now       = new Date().toISOString();
      const subject   = (subjectTpl || 'Your Ad Proof — {MONTH} Mailing | Please Review by {DEADLINE}')
        .replace(/{MONTH}/g, mailingMonthLabel).replace(/{DEADLINE}/g, deadline).replace(/{BUSINESS}/g, client.business);

      const html = buildEmail(client, mailingMonthLabel, deadline, items, sessionId, bodyTemplate);
      await sendEmail(client.email, client.contact || client.business, subject, html);
      await saveRecord(blobSvc, {
        sessionId, business: client.business, contact: client.contact || '',
        email: client.email, mailingMonth: String(mailingMonth).padStart(2,'0'),
        mailingYear: String(mailingYear), mailingMonthLabel, deadline,
        isResend: !!isResend, filesUsed: matchedFiles,
        status: 'sent', sentAt: now, openedAt: null, openCount: 0, respondedAt: null, response: null, notes: ''
      });

      results.push({ business: client.business, status: 'sent', sessionId });
      await new Promise(r => setTimeout(r, 500));

    } catch(e) {
      context.log.error('Error:', client.business, e.message);
      results.push({ business: client.business, status: 'error', message: e.message });
    }
  }

  context.res = { status: 200, headers: CORS, body: JSON.stringify({ ok: true, results }) };
  context.done();
};
