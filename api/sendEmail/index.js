// api/sendEmail/index.js
const { BlobServiceClient } = require('@azure/storage-blob');
const { v4: uuidv4 } = require('uuid');
const STORAGE_CONN  = process.env.AZURE_STORAGE_CONNECTION_STRING;
const TENANT_ID     = process.env.TENANT_ID;
const CLIENT_ID     = process.env.GRAPH_CLIENT_ID;
const CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET;
const FROM_EMAIL    = process.env.PUBLISHER_EMAIL || 'josh@thetexanlocal.com';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

async function getToken() {
  const p = new URLSearchParams({ grant_type:'client_credentials', client_id:CLIENT_ID, client_secret:CLIENT_SECRET, scope:'https://graph.microsoft.com/.default' });
  const r = await fetch('https://login.microsoftonline.com/'+TENANT_ID+'/oauth2/v2.0/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:p.toString() });
  const d = await r.json();
  if (!d.access_token) throw new Error('Token failed');
  return d.access_token;
}

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res={status:200,headers:CORS,body:'{}'}; context.done(); return; }

  const { to, subject, htmlBody, attachments, trackingId } = req.body || {};
  if (!to||!to.length||!subject||!htmlBody) {
    context.res={status:400,headers:CORS,body:JSON.stringify({error:'Missing required fields'})}; context.done(); return;
  }

  try {
    const token = await getToken();
    const msg = {
      subject,
      body: { contentType:'HTML', content:htmlBody },
      toRecipients: to.map(function(r){ return { emailAddress:{ address:r.email, name:r.name||r.email } }; }),
      from: { emailAddress:{ address:FROM_EMAIL, name:'Josh Knight — The Texan Local' } }
    };

    if (attachments && attachments.length) {
      msg.attachments = attachments.map(function(a) {
        return { '@odata.type':'#microsoft.graph.fileAttachment', name:a.name, contentType:a.type||'application/octet-stream', contentBytes:a.data };
      });
    }

    const res = await fetch('https://graph.microsoft.com/v1.0/users/'+FROM_EMAIL+'/sendMail', {
      method:'POST', headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},
      body: JSON.stringify({ message:msg, saveToSentItems:true })
    });
    if (res.status !== 202) throw new Error('sendMail failed: '+res.status);

    // Save to email log
    const logEntry = {
      emailId:    uuidv4(),
      trackingId: trackingId||'',
      to:         to,
      subject,
      sentAt:     new Date().toISOString(),
      openedAt:   null,
      openCount:  0
    };
    const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient('portal-data');
    await container.createIfNotExists();
    const buf = Buffer.from(JSON.stringify(logEntry));
    await container.getBlockBlobClient('email-log/'+logEntry.emailId+'.json')
      .upload(buf, buf.length, { overwrite:true, blobHTTPHeaders:{blobContentType:'application/json'} });

    context.res = { status:200, headers:CORS, body: JSON.stringify({ ok:true, emailId:logEntry.emailId }) };
  } catch(e) {
    context.log.error('sendEmail error:', e.message);
    context.res = { status:500, headers:CORS, body: JSON.stringify({ error:e.message }) };
  }
  context.done();
};
