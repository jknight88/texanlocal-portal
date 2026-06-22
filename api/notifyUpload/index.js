// api/notifyUpload/index.js
// Called after Sherry uploads revised proofs — notifies Josh
const { BlobServiceClient } = require('@azure/storage-blob');
const STORAGE_CONN  = process.env.AZURE_STORAGE_CONNECTION_STRING;
const TENANT_ID     = process.env.TENANT_ID;
const CLIENT_ID     = process.env.GRAPH_CLIENT_ID;
const CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET;
const FROM_EMAIL    = process.env.PUBLISHER_EMAIL || 'josh@thetexanlocal.com';
const BASE_URL      = process.env.BASE_URL || 'https://portal.thetexanlocal.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
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

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res={status:200,headers:CORS,body:'{}'}; context.done(); return; }

  const { files, month, year } = req.body || {};
  if (!files || !files.length) { context.res={status:400,headers:CORS,body:JSON.stringify({error:'No files'})}; context.done(); return; }

  try {
    // Load publisher info from company settings
    let pubEmail = FROM_EMAIL;
    let pubName  = 'Josh';
    try {
      const blobSvc = BlobServiceClient.fromConnectionString(STORAGE_CONN);
      const buf     = await blobSvc.getContainerClient('portal-data').getBlockBlobClient('company-settings.json').downloadToBuffer();
      const s       = JSON.parse(buf.toString());
      if (s.pubEmail)     pubEmail = s.pubEmail;
      if (s.pubPublisher) pubName  = s.pubPublisher.split(' ')[0];
    } catch(e) {}

    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const monthLabel = MONTHS[parseInt(month)-1] + ' ' + year;
    const fileList   = files.map(function(f){ return '<li style="padding:3px 0;font-size:13px;color:#1a1a2e">📄 '+f+'</li>'; }).join('');

    const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#00205B;padding:18px 28px;border-bottom:4px solid #BF0D3E">
        <span style="font-family:Georgia,serif;font-size:20px;color:#fff;font-weight:700">The Texan Local</span>
      </div>
      <div style="padding:24px 28px">
        <p style="font-size:15px;margin-bottom:16px">Hi ${pubName},</p>
        <p style="font-size:14px;line-height:1.7;margin-bottom:16px">
          Sherry has uploaded <strong>${files.length} revised proof${files.length>1?'s':''}</strong> for the <strong>${monthLabel}</strong> mailing. ${files.length>1?'These files are':'This file is'} ready for review and resending.
        </p>
        <div style="background:#f9fafc;border:1px solid #e0e3ea;border-radius:6px;padding:14px 18px;margin-bottom:20px">
          <div style="font-size:11px;font-weight:700;color:#4a4f5e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Uploaded Files</div>
          <ul style="list-style:none;padding:0;margin:0">${fileList}</ul>
        </div>
        <div style="text-align:center;margin:24px 0">
          <a href="${BASE_URL}/approvals/dashboard" style="background:#00205B;color:#fff;padding:12px 24px;border-radius:5px;text-decoration:none;font-size:13px;font-weight:700;margin-right:10px">View Approvals Dashboard</a>
          <a href="${BASE_URL}/files" style="background:#BF0D3E;color:#fff;padding:12px 24px;border-radius:5px;text-decoration:none;font-size:13px;font-weight:700">View Files</a>
        </div>
      </div>
      <div style="border-top:3px solid #BF0D3E;padding:14px 28px;font-size:12px;color:#888">
        The Texan Local Portal · Automated Upload Notification
      </div>
    </body></html>`;

    const token = await getGraphToken();
    const res   = await fetch('https://graph.microsoft.com/v1.0/users/'+FROM_EMAIL+'/sendMail', {
      method:'POST',
      headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},
      body: JSON.stringify({
        message: {
          subject: 'Revised Proof'+(files.length>1?'s':'')+' Uploaded — '+monthLabel,
          body:    { contentType:'HTML', content:html },
          toRecipients: [{ emailAddress:{ address:pubEmail, name:pubName } }],
          from:         { emailAddress:{ address:FROM_EMAIL, name:'The Texan Local Portal' } }
        },
        saveToSentItems: true
      })
    });
    if (res.status !== 202) throw new Error('sendMail: '+res.status);
    context.res = { status:200, headers:CORS, body:JSON.stringify({ok:true}) };
  } catch(e) {
    context.log.error('notifyUpload error:', e.message);
    context.res = { status:500, headers:CORS, body:JSON.stringify({error:e.message}) };
  }
  context.done();
};
