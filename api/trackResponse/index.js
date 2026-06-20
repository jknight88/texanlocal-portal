// api/trackResponse/index.js
const { BlobServiceClient } = require('@azure/storage-blob');
const STORAGE_CONN    = process.env.AZURE_STORAGE_CONNECTION_STRING;
const BASE_URL        = process.env.BASE_URL        || 'https://portal.thetexanlocal.com';
const TENANT_ID       = process.env.TENANT_ID;
const CLIENT_ID       = process.env.GRAPH_CLIENT_ID;
const CLIENT_SECRET   = process.env.GRAPH_CLIENT_SECRET;
const FROM_EMAIL      = process.env.REP_EMAIL       || 'josh@thetexanlocal.com';
const DESIGNER_EMAIL  = process.env.DESIGNER_EMAIL  || 'sherry.workofheart@gmail.com';
const NOTIFY_EMAIL    = process.env.NOTIFY_EMAIL    || FROM_EMAIL;
const CONTAINER       = 'ad-approvals';

async function getGraphToken() {
  const params = new URLSearchParams({
    grant_type: 'client_credentials', client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET, scope: 'https://graph.microsoft.com/.default'
  });
  const res  = await fetch('https://login.microsoftonline.com/'+TENANT_ID+'/oauth2/v2.0/token',
    { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:params.toString() });
  const data = await res.json();
  if (!data.access_token) throw new Error('Graph token failed');
  return data.access_token;
}

async function sendEmail(to, toName, subject, html, cc) {
  const token = await getGraphToken();
  const msg = {
    subject,
    body: { contentType:'HTML', content:html },
    toRecipients: [{ emailAddress:{ address:to, name:toName||to } }],
    from: { emailAddress:{ address:FROM_EMAIL, name:'Josh Knight — The Texan Local' } }
  };
  if (cc && cc.address) msg.ccRecipients = [{ emailAddress: cc }];
  const res = await fetch('https://graph.microsoft.com/v1.0/users/'+FROM_EMAIL+'/sendMail', {
    method: 'POST',
    headers: { 'Authorization':'Bearer '+token, 'Content-Type':'application/json' },
    body: JSON.stringify({ message: msg, saveToSentItems: true })
  });
  if (res.status !== 202) throw new Error('sendMail failed: '+res.status);
}

module.exports = async function(context, req) {
  const sessionId = req.query.id;
  const action    = req.query.action; // 'approved' or 'changes'

  if (sessionId && (action === 'approved' || action === 'changes')) {
    let record = null;
    try {
      const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
      const container = blobSvc.getContainerClient(CONTAINER);
      const blob      = container.getBlockBlobClient(sessionId + '.json');
      const dl        = await blob.downloadToBuffer();
      record    = JSON.parse(dl.toString());

      const now = new Date().toISOString();
      record.respondedAt = now;
      record.response    = action;
      record.status      = action === 'approved' ? 'approved' : 'changes_requested';
      if (!record.openedAt) { record.openedAt = now; record.openCount = (record.openCount||0)+1; }

      const buf = Buffer.from(JSON.stringify(record));
      await blob.upload(buf, buf.length, { overwrite:true, blobHTTPHeaders:{blobContentType:'application/json'} });

      // If changes requested — email designer AND notify rep
      if (action === 'changes') {
        const biz      = record.business || record.clientName || 'A client';
        const month    = record.month    || '';
        const filename = record.filename || record.proofFile || '';
        const dashUrl  = BASE_URL + '/approvals/dashboard';
        const fileUrl  = BASE_URL + '/files';

        // Email to designer (Sherry)
        const designerHtml = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
          <div style="background:#00205B;padding:18px 28px;border-bottom:4px solid #BF0D3E">
            <span style="font-family:Georgia,serif;font-size:20px;color:#fff;font-weight:700">The Texan Local</span>
          </div>
          <div style="padding:24px 28px">
            <p style="font-size:15px;margin-bottom:16px">Hi ${designerName},</p>
            <p style="font-size:14px;line-height:1.7;margin-bottom:16px">
              <strong>${biz}</strong> has requested changes to their ad proof for the <strong>${month}</strong> mailing.
            </p>
            <div style="background:#fff8e1;border-left:4px solid #f5a623;padding:12px 16px;border-radius:4px;margin-bottom:20px">
              <div style="font-size:13px;font-weight:700;color:#e65100;margin-bottom:4px">⚠ Changes Needed</div>
              <div style="font-size:13px;color:#333">Client: <strong>${biz}</strong></div>
              ${filename ? '<div style="font-size:13px;color:#333">File: <strong>'+filename+'</strong></div>' : ''}
              <div style="font-size:13px;color:#333">Month: <strong>${month}</strong></div>
            </div>
            <p style="font-size:13px;color:#555;line-height:1.6;margin-bottom:20px">
              Please make the necessary revisions and upload the updated proof to the portal file manager. 
              Josh will be notified automatically once the file is uploaded.
            </p>
            <div style="text-align:center;margin:24px 0">
              <a href="${fileUrl}" style="background:#00205B;color:#fff;padding:12px 28px;border-radius:5px;text-decoration:none;font-size:14px;font-weight:700">
                Upload Revised Proof
              </a>
            </div>
          </div>
          <div style="border-top:3px solid #BF0D3E;padding:16px 28px;font-size:13px;color:#333">
            <strong>Josh Knight</strong>, Publisher &nbsp;·&nbsp; 830-214-3487
          </div>
        </body></html>`;

        // Email to rep (Josh) — notify that changes were requested
        const repHtml = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
          <div style="background:#00205B;padding:18px 28px;border-bottom:4px solid #BF0D3E">
            <span style="font-family:Georgia,serif;font-size:20px;color:#fff;font-weight:700">The Texan Local</span>
          </div>
          <div style="padding:24px 28px">
            <p style="font-size:15px;margin-bottom:16px">Hi Josh,</p>
            <p style="font-size:14px;line-height:1.7;margin-bottom:16px">
              <strong>${biz}</strong> has requested changes to their ad proof for the <strong>${month}</strong> mailing.
              Sherry has been notified and will upload a revised proof.
            </p>
            <div style="background:#fff8e1;border-left:4px solid #f5a623;padding:12px 16px;border-radius:4px;margin-bottom:20px">
              <div style="font-size:13px;font-weight:700;color:#e65100;margin-bottom:4px">⚠ Changes Requested</div>
              <div style="font-size:13px;color:#333">Client: <strong>${biz}</strong></div>
              ${filename ? '<div style="font-size:13px;color:#333">File: <strong>'+filename+'</strong></div>' : ''}
            </div>
            <div style="text-align:center;margin:24px 0">
              <a href="${dashUrl}" style="background:#00205B;color:#fff;padding:12px 28px;border-radius:5px;text-decoration:none;font-size:14px;font-weight:700">
                View Approval Dashboard
              </a>
            </div>
          </div>
          <div style="border-top:3px solid #BF0D3E;padding:16px 28px;font-size:13px;color:#333">
            <strong>The Texan Local Portal</strong> &nbsp;·&nbsp; Automated Notification
          </div>
        </body></html>`;

        try { await sendEmail(DESIGNER_EMAIL, 'Sherry Justice', 'Ad Changes Needed — '+biz+' ('+month+')', designerHtml); }
        catch(e) { context.log.warn('Designer email failed:', e.message); }

        try { await sendEmail(NOTIFY_EMAIL, 'Josh Knight', 'Changes Requested — '+biz+' ('+month+')', repHtml); }
        catch(e) { context.log.warn('Rep notification email failed:', e.message); }
      }

    } catch(e) {
      context.log.warn('trackResponse error:', e.message);
    }
  }

  // Redirect to respond page
  // Pass business name to respond page
  const bizParam = record && record.business ? '&biz='+encodeURIComponent(record.business) : '';
  context.res = {
    status: 302,
    headers: { 'Location': BASE_URL+'/respond?id='+sessionId+'&action='+action+bizParam }
  };
  context.done();
};
