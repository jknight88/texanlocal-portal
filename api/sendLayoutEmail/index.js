const TENANT_ID     = process.env.TENANT_ID;
const CLIENT_ID     = process.env.GRAPH_CLIENT_ID;
const CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET;
const FROM_EMAIL    = process.env.REP_EMAIL || 'josh@thetexanlocal.com';
const BASE_URL      = process.env.BASE_URL  || 'https://portal.thetexanlocal.com';
const CORS = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization','Content-Type':'application/json'};

async function getToken() {
  const params = new URLSearchParams({ grant_type:'client_credentials', client_id:CLIENT_ID, client_secret:CLIENT_SECRET, scope:'https://graph.microsoft.com/.default' });
  const res  = await fetch('https://login.microsoftonline.com/'+TENANT_ID+'/oauth2/v2.0/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:params.toString() });
  const data = await res.json();
  if (!data.access_token) throw new Error('Token error');
  return data.access_token;
}

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res={status:200,headers:CORS,body:'{}'}; context.done(); return; }
  const { to, toName, zone, zoneName, month, pageList, totalPages } = req.body || {};
  if (!to || !zone || !pageList) { context.res={status:400,headers:CORS,body:JSON.stringify({error:'Missing fields'})}; context.done(); return; }

  const subject = 'Magazine Layout — Zone ' + zone + ' — ' + month;
  const pageListHtml = pageList.split('\n').filter(Boolean).map(function(line) {
    return '<tr><td style="padding:6px 12px;border-bottom:1px solid #eee;font-size:13px;font-family:monospace;color:#1a1a2e">' + line + '</td></tr>';
  }).join('');

  const html = '<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:650px;margin:0 auto">' +
    '<div style="background:#00205B;padding:18px 28px;border-bottom:4px solid #BF0D3E">' +
    '<span style="font-family:Georgia,serif;font-size:20px;color:#fff;font-weight:700">The Texan Local</span></div>' +
    '<div style="padding:24px 28px">' +
    '<p style="font-size:15px;margin-bottom:16px">Hi ' + (toName||'Sherry') + ',</p>' +
    '<p style="font-size:14px;margin-bottom:20px">Here is the page layout for <strong>Zone ' + zone + ' — ' + zoneName + '</strong> for the <strong>' + month + '</strong> mailing (' + totalPages + ' pages):</p>' +
    '<table style="width:100%;border-collapse:collapse;background:#f9fafc;border-radius:6px;overflow:hidden">' +
    '<tr><th style="padding:8px 12px;background:#00205B;color:#fff;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.5px">Page Assignment</th></tr>' +
    pageListHtml +
    '</table>' +
    '<p style="font-size:13px;margin-top:20px;color:#666">You can view the full layout in the portal: <a href="' + BASE_URL + '/layout" style="color:#00205B;font-weight:700">Open Layout Builder</a></p>' +
    '</div>' +
    '<div style="border-top:3px solid #BF0D3E;padding:16px 28px;font-size:13px;color:#333">' +
    '<strong>Josh Knight</strong>, Publisher &nbsp;·&nbsp; 830-214-3487</div>' +
    '</body></html>';

  try {
    const token = await getToken();
    const res = await fetch('https://graph.microsoft.com/v1.0/users/'+FROM_EMAIL+'/sendMail', {
      method:'POST',
      headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType:'HTML', content:html },
          toRecipients: [{ emailAddress:{ address:to, name:toName||to } }],
          from: { emailAddress:{ address:FROM_EMAIL, name:'Josh Knight — The Texan Local' } }
        },
        saveToSentItems: true
      })
    });
    if (res.status !== 202) throw new Error('sendMail: ' + res.status);
    context.res = { status:200, headers:CORS, body: JSON.stringify({ ok:true }) };
  } catch(e) {
    context.res = { status:500, headers:CORS, body: JSON.stringify({ error: e.message }) };
  }
  context.done();
};
