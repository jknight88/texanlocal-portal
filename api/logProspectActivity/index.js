const { BlobServiceClient } = require('@azure/storage-blob');
const STORAGE_CONN  = process.env.AZURE_STORAGE_CONNECTION_STRING;
const TENANT_ID     = process.env.TENANT_ID;
const CLIENT_ID     = process.env.GRAPH_CLIENT_ID;
const CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET;
const CONTAINER     = 'portal-data';
const CORS = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization','Content-Type':'application/json' };

async function getGraphToken() {
  const params = new URLSearchParams({ grant_type:'client_credentials', client_id:CLIENT_ID, client_secret:CLIENT_SECRET, scope:'https://graph.microsoft.com/.default' });
  const res  = await fetch('https://login.microsoftonline.com/' + TENANT_ID + '/oauth2/v2.0/token', { method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' }, body:params.toString() });
  const data = await res.json();
  if (!data.access_token) throw new Error('Token error');
  return data.access_token;
}

async function createCalendarEvent(ownerEmail, subject, startDateTime, endDateTime, body) {
  const token = await getGraphToken();
  const res   = await fetch('https://graph.microsoft.com/v1.0/users/' + ownerEmail + '/calendar/events', {
    method: 'POST',
    headers: { 'Authorization':'Bearer ' + token, 'Content-Type':'application/json' },
    body: JSON.stringify({
      subject,
      body: { contentType:'Text', content: body },
      start: { dateTime: startDateTime, timeZone:'America/Chicago' },
      end:   { dateTime: endDateTime,   timeZone:'America/Chicago' },
      isReminderOn: true,
      reminderMinutesBeforeStart: 30
    })
  });
  if (!res.ok) throw new Error('Calendar error: ' + res.status + ' ' + await res.text());
  return await res.json();
}

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res = { status:200, headers:CORS, body:'{}' }; context.done(); return; }
  try {
    const { prospectId, entry, newStatus } = req.body || {};
    if (!prospectId || !entry) { context.res = { status:400, headers:CORS, body: JSON.stringify({ error:'Missing fields' }) }; context.done(); return; }

    const blobSvc = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const c = blobSvc.getContainerClient(CONTAINER);
    const blob = c.getBlockBlobClient('prospects.json');
    let prospects = [];
    try { prospects = JSON.parse((await blob.downloadToBuffer()).toString()); } catch(e) {}

    const prospect = prospects.find(function(p) { return p.id === prospectId; });
    if (!prospect) { context.res = { status:404, headers:CORS, body: JSON.stringify({ error:'Prospect not found' }) }; context.done(); return; }

    // Try to create calendar event if follow-up date set and owner has M365 email
    let calendarCreated = false;
    if (entry.followupDate && entry.ownerEmail && entry.ownerEmail.includes('@') && !entry.ownerEmail.includes('gmail') && !entry.ownerEmail.includes('yahoo') && !entry.ownerEmail.includes('hotmail')) {
      try {
        const startDT = entry.followupDate + 'T' + (entry.followupTime || '09:00') + ':00';
        const endDT   = entry.followupDate + 'T' + (entry.followupTime ? addHour(entry.followupTime) : '10:00') + ':00';
        const subject = 'Follow up with ' + prospect.business;
        const body    = 'Prospect: ' + prospect.business + '\nContact: ' + (prospect.contact||'') + '\nPhone: ' + (prospect.phone||'') + '\nNotes: ' + (entry.notes||'');
        await createCalendarEvent(entry.ownerEmail, subject, startDT, endDT, body);
        calendarCreated = true;
        context.log('Calendar event created for', entry.ownerEmail);
      } catch(e) {
        context.log.warn('Calendar event failed:', e.message);
      }
    }

    entry.calendarCreated = calendarCreated;
    if (!prospect.activity) prospect.activity = [];
    prospect.activity.push(entry);
    prospect.lastActivity = entry.dateTime || new Date().toISOString();
    if (newStatus) prospect.status = newStatus;
    prospect.updatedAt = new Date().toISOString();

    const buf = Buffer.from(JSON.stringify(prospects));
    await blob.upload(buf, buf.length, { overwrite:true, blobHTTPHeaders:{ blobContentType:'application/json' } });
    context.res = { status:200, headers:CORS, body: JSON.stringify({ ok:true, calendarCreated }) };
  } catch(e) {
    context.log.error('logProspectActivity error:', e.message);
    context.res = { status:500, headers:CORS, body: JSON.stringify({ error: e.message }) };
  }
  context.done();
};

function addHour(time) {
  const parts = time.split(':');
  return String(Math.min(parseInt(parts[0]) + 1, 23)).padStart(2,'0') + ':' + parts[1];
}
