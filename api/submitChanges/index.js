// api/submitChanges/index.js
// POST { sessionId, clientName, changes, business }
// Updates approval record with change details and emails designer + rep
const { BlobServiceClient } = require('@azure/storage-blob');
const STORAGE_CONN   = process.env.AZURE_STORAGE_CONNECTION_STRING;
const TENANT_ID      = process.env.TENANT_ID;
const CLIENT_ID      = process.env.GRAPH_CLIENT_ID;
const CLIENT_SECRET  = process.env.GRAPH_CLIENT_SECRET;
const FROM_EMAIL     = process.env.PUBLISHER_EMAIL    || 'josh@thetexanlocal.com';
const DESIGNER_EMAIL = process.env.DESIGNER_EMAIL || 'sherry.workofheart@gmail.com';
const BASE_URL       = process.env.BASE_URL     || 'https://portal.thetexanlocal.com';
const CONTAINER      = 'ad-approvals';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

async function getGraphToken() {
  const p = new URLSearchParams({ grant_type:'client_credentials', client_id:CLIENT_ID, client_secret:CLIENT_SECRET, scope:'https://graph.microsoft.com/.default' });
  const r = await fetch('https://login.microsoftonline.com/'+TENANT_ID+'/oauth2/v2.0/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:p.toString() });
  const d = await r.json();
  if (!d.access_token) throw new Error('Token failed');
  return d.access_token;
}

async function sendMail(token, to, toName, subject, html, cc) {
  const msg = {
    subject,
    body: { contentType:'HTML', content:html },
    toRecipients: [{ emailAddress:{ address:to, name:toName||to } }],
    from: { emailAddress:{ address:FROM_EMAIL, name:'The Texan Local' } }
  };
  if (cc) msg.ccRecipients = [{ emailAddress:{ address:cc.address, name:cc.name||cc.address } }];
  const r = await fetch('https://graph.microsoft.com/v1.0/users/'+FROM_EMAIL+'/sendMail', {
    method:'POST', headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},
    body: JSON.stringify({ message:msg, saveToSentItems:true })
  });
  if (r.status !== 202) throw new Error('sendMail failed: '+r.status);
}

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res={status:200,headers:CORS,body:'{}'}; context.done(); return; }

  const { sessionId, clientName, changes, business } = req.body || {};
  if (!sessionId || !clientName || !changes) {
    context.res={status:400,headers:CORS,body:JSON.stringify({error:'Missing required fields'})}; context.done(); return;
  }

  try {
    const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient(CONTAINER);

    // Load company settings for designer/rep info
    let designerEmail = DESIGNER_EMAIL;
    let designerName  = 'Sherry';
    let repEmail      = FROM_EMAIL;
    let repName       = 'Josh';
    try {
      const sc  = blobSvc.getContainerClient('portal-data');
      const buf = await sc.getBlockBlobClient('company-settings.json').downloadToBuffer();
      const s   = JSON.parse(buf.toString());
      if (s.designerEmail) designerEmail = s.designerEmail;
      if (s.designerName)  designerName  = s.designerName.split(' ')[0];
      if (s.pubEmail)      repEmail      = s.pubEmail;
      if (s.pubPublisher)  repName       = s.pubPublisher.split(' ')[0];
    } catch(e) {}

    // Update approval record
    let biz = business || '';
    let month = '';
    let filesUsed = '';
    try {
      const blob   = container.getBlockBlobClient(sessionId+'.json');
      const dl     = await blob.downloadToBuffer();
      const record = JSON.parse(dl.toString());
      record.status          = 'changes_requested';
      record.respondedAt     = new Date().toISOString();
      record.response        = 'changes';
      record.changeRequestor = clientName;
      record.changeNotes     = changes;
      biz       = record.business || business || '';
      month     = record.mailingMonthLabel || '';
      filesUsed = record.filesUsed ? record.filesUsed.join(', ') : '';
      const buf = Buffer.from(JSON.stringify(record));
      await blob.upload(buf, buf.length, { overwrite:true, blobHTTPHeaders:{blobContentType:'application/json'} });
    } catch(e) { context.log.warn('Record update failed:', e.message); }

    // Build email HTML
    const emailHtml = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#00205B;padding:18px 28px;border-bottom:4px solid #BF0D3E">
        <span style="font-family:Georgia,serif;font-size:20px;color:#fff;font-weight:700">The Texan Local</span>
      </div>
      <div style="padding:24px 28px">
        <div style="background:#ffebee;border-left:4px solid #BF0D3E;padding:14px 16px;border-radius:4px;margin-bottom:20px">
          <div style="font-size:14px;font-weight:700;color:#c62828;margin-bottom:6px">✏ Ad Changes Requested</div>
          <div style="font-size:13px;color:#333;margin-bottom:3px">Business: <strong>${biz}</strong></div>
          <div style="font-size:13px;color:#333;margin-bottom:3px">Submitted by: <strong>${clientName}</strong></div>
          ${month ? '<div style="font-size:13px;color:#333;margin-bottom:3px">Month: <strong>'+month+'</strong></div>' : ''}
          ${filesUsed ? '<div style="font-size:13px;color:#333">File(s): <strong>'+filesUsed+'</strong></div>' : ''}
        </div>
        <div style="background:#f9fafc;border:1px solid #e0e3ea;border-radius:6px;padding:16px;margin-bottom:20px">
          <div style="font-size:12px;font-weight:700;color:#4a4f5e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Changes Requested:</div>
          <div style="font-size:14px;color:#1a1a2e;line-height:1.7;white-space:pre-wrap">${changes}</div>
        </div>
        <div style="text-align:center">
          <a href="${BASE_URL}/approvals/dashboard" style="background:#00205B;color:#fff;padding:11px 24px;border-radius:5px;text-decoration:none;font-size:13px;font-weight:700">View Approval Dashboard</a>
        </div>
      </div>
      <div style="border-top:3px solid #BF0D3E;padding:14px 28px;font-size:12px;color:#888">The Texan Local Portal · Automated Notification</div>
    </body></html>`;

    const subject = 'Ad Changes Requested — ' + biz + (month ? ' ('+month+')' : '');
    const token   = await getGraphToken();

    // Send to designer CC rep
    await sendMail(token, designerEmail, designerName, subject, emailHtml, { address:repEmail, name:repName });

    context.res = { status:200, headers:CORS, body:JSON.stringify({ok:true}) };
  } catch(e) {
    context.log.error('submitChanges error:', e.message);
    context.res = { status:500, headers:CORS, body:JSON.stringify({error:e.message}) };
  }
  context.done();
};
