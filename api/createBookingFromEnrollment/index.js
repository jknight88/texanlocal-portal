// api/createBookingFromEnrollment/index.js
// Retries booking creation from a completed enrollment record
const { BlobServiceClient } = require('@azure/storage-blob');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const BASE_URL     = process.env.BASE_URL || 'https://portal.thetexanlocal.com';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res={status:200,headers:CORS,body:'{}'}; context.done(); return; }

  const { sessionId } = req.body || {};
  if (!sessionId) {
    context.res={status:400,headers:CORS,body:JSON.stringify({error:'Missing sessionId'})}; context.done(); return;
  }

  try {
    const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient('enrollments');
    const blob      = container.getBlockBlobClient(sessionId+'.json');
    const buf       = await blob.downloadToBuffer();
    const record    = JSON.parse(buf.toString());

    if (record.status !== 'signed' && record.status !== 'client_signed') {
      context.res={status:400,headers:CORS,body:JSON.stringify({error:'Enrollment not fully signed (status: '+record.status+')'})}; context.done(); return;
    }
    if (record.bookingContractId) {
      context.res={status:200,headers:CORS,body:JSON.stringify({ok:true,alreadyExists:true,contractId:record.bookingContractId})}; context.done(); return;
    }

    // Build contract payload from enrollment record
    const fd = record.formData || {};
    const termStr = (fd.term||record.term||'12').toString().replace(/\s*months?/i,'').trim();
    const termNum = parseInt(termStr) || 12;
    const formZones = fd.zones || record.zones || [];

    const contractZones = formZones.filter(function(z){
      return z.product && z.startMonth && parseFloat(z.rate||0) > 0;
    }).map(function(z){
      return { zoneName:z.zoneName||z.id||'', product:z.product, startMonth:z.startMonth, rate:parseFloat(z.rate||0) };
    });

    if (!contractZones.length) {
      context.res={status:400,headers:CORS,body:JSON.stringify({error:'No zone/product data found in enrollment record'})}; context.done(); return;
    }

    const addons = [];
    const addonDetail = (fd.addonDetail||'');
    if (/setup/i.test(addonDetail))       addons.push({ name:'Setup Fee',         amount:100, type:'onetime'   });
    if (/call.?track/i.test(addonDetail)) addons.push({ name:'Call Tracking',     amount:0,   type:'recurring' });
    if (/premium/i.test(addonDetail))     addons.push({ name:'Premium Placement', amount:0,   type:'recurring' });

    const saveRes = await fetch(`${BASE_URL}/api/saveContract`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({
        business:    record.bizName    || fd.bizName    || '',
        contact:     record.contact    || fd.contact    || '',
        email:       record.clientEmail|| fd.clientEmail|| '',
        phone:       record.phone      || fd.phone      || '',
        addr:        record.addr       || fd.addr       || '',
        city:        record.city       || fd.city       || '',
        state:       record.state      || fd.state      || 'TX',
        zip:         record.zip        || fd.zip        || '',
        term:        termNum,
        zones:       contractZones,
        addons,
        signedDate:  (record.countersignedAt||record.signedAt||'').split('T')[0] || new Date().toISOString().split('T')[0],
        firstMonth:  fd.firstMonth || '',
        monthly:     fd.monthly    || '',
        notes:       fd.notes      || '',
        rep:         fd.rep        || '',
        source:      'enrollment',
        enrollmentId: sessionId
      })
    });

    const saveData = await saveRes.json();
    if (!saveRes.ok || !saveData.ok) throw new Error(saveData.error||'saveContract failed');

    // Update enrollment record with contractId
    record.bookingContractId = saveData.contractId;
    const updated = Buffer.from(JSON.stringify(record));
    await blob.upload(updated, updated.length, { overwrite:true, blobHTTPHeaders:{blobContentType:'application/json'} });

    context.log('Retry booking created:', saveData.contractId, 'slots:', saveData.bookingsCreated);
    context.res = { status:200, headers:CORS, body: JSON.stringify({ ok:true, contractId:saveData.contractId, bookingsCreated:saveData.bookingsCreated }) };
  } catch(e) {
    context.log.error('createBookingFromEnrollment error:', e.message);
    context.res = { status:500, headers:CORS, body: JSON.stringify({ error:e.message }) };
  }
  context.done();
};
