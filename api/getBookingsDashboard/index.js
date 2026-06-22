// api/getBookingsDashboard/index.js
const { BlobServiceClient } = require('@azure/storage-blob');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER    = 'portal-data';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

// Priority order for approval status
const APPROVAL_PRIORITY = {
  'approved': 6, 'changes_requested': 5, 'opened': 4, 'sent': 3, 'no_file': 2
};

function normBiz(s) { return (s||'').toLowerCase().replace(/[^a-z0-9]/g,''); }

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res={status:200,headers:CORS,body:'{}'}; context.done(); return; }

  const month = req.query.month || '';
  const view  = req.query.view  || 'month';

  try {
    const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient(CONTAINER);
    await container.createIfNotExists();

    // ── Parallel fetch all bookings ───────────────────────────────────────────
    const bkNames = [];
    for await (const b of container.listBlobsFlat({ prefix:'bookings/' })) {
      if (b.name.endsWith('.json')) bkNames.push(b.name);
    }

    const allBookings = [];
    const batchSize = 25;
    for (let i=0; i<bkNames.length; i+=batchSize) {
      const batch = bkNames.slice(i, i+batchSize);
      const results = await Promise.all(batch.map(async function(name) {
        try { return JSON.parse((await container.getBlockBlobClient(name).downloadToBuffer()).toString()); }
        catch(e) { return null; }
      }));
      results.forEach(function(b){ if(b) allBookings.push(b); });
    }

    // ── Renewals view ─────────────────────────────────────────────────────────
    if (view === 'renewals') {
      const now = new Date(), in30 = new Date(now), in60 = new Date(now);
      in30.setDate(now.getDate()+30); in60.setDate(now.getDate()+60);
      const renewals = allBookings.filter(function(b) {
        if (b.status === 'cancelled' || b.status === 'skipped') return false;
        if (b.termIndex !== b.totalTermMonths) return false;
        const expDate = new Date(b.year, parseInt(b.month)-1, 28);
        return expDate >= now && expDate <= in60;
      }).map(function(b) {
        const expDate = new Date(b.year, parseInt(b.month)-1, 28);
        return Object.assign({}, b, {
          expiresIn: Math.ceil((expDate-now)/(1000*60*60*24)),
          urgency:   expDate <= in30 ? 'soon' : 'upcoming'
        });
      });
      renewals.sort(function(a,b){ return a.expiresIn - b.expiresIn; });
      context.res = { status:200, headers:CORS, body: JSON.stringify({ renewals }) };
      context.done(); return;
    }

    // ── Monthly view ──────────────────────────────────────────────────────────
    const filtered = month
      ? allBookings.filter(function(b){ return b.monthYear === month && b.status !== 'cancelled' && b.status !== 'skipped'; })
      : allBookings.filter(function(b){ return b.status !== 'cancelled' && b.status !== 'skipped'; });

    // Load approval records for this month to get art/approval status
    let approvalRecords = [];
    try {
      const appC = blobSvc.getContainerClient('ad-approvals');
      const appNames = [];
      for await (const b of appC.listBlobsFlat()) {
        if (b.name.endsWith('.json')) appNames.push(b.name);
      }
      for (let i=0; i<appNames.length; i+=batchSize) {
        const batch = appNames.slice(i, i+batchSize);
        const results = await Promise.all(batch.map(async function(name) {
          try { return JSON.parse((await appC.getBlockBlobClient(name).downloadToBuffer()).toString()); }
          catch(e) { return null; }
        }));
        results.forEach(function(r) {
          if (!r) return;
          if (month && (r.mailingMonth !== month.split('-')[1] || r.mailingYear !== month.split('-')[0])) return;
          approvalRecords.push(r);
        });
      }
    } catch(e) { context.log.warn('Could not load approvals:', e.message); }

    // Build approval lookup: normalized business → best status
    const approvalByBiz = {};
    approvalRecords.forEach(function(r) {
      const key = normBiz(r.business);
      const pri = APPROVAL_PRIORITY[r.status] || 0;
      if (!approvalByBiz[key] || pri > (APPROVAL_PRIORITY[approvalByBiz[key].status]||0)) {
        approvalByBiz[key] = r;
      }
    });

    // Merge approval status into bookings
    const bookingsWithStatus = filtered.map(function(b) {
      const key = normBiz(b.business);
      const apr = approvalByBiz[key];
      let artStatus = 'art_not_sent';
      if (apr) {
        if      (apr.status === 'approved')           artStatus = 'approved';
        else if (apr.status === 'changes_requested')  artStatus = 'changes_requested';
        else if (apr.status === 'opened')             artStatus = 'art_opened';
        else if (apr.status === 'sent')               artStatus = 'art_sent';
      }
      return Object.assign({}, b, { artStatus });
    });

    bookingsWithStatus.sort(function(a,b){
      return (a.zone||'').localeCompare(b.zone||'') || (a.business||'').localeCompare(b.business||'');
    });

    // Zone summaries
    const zoneSummary = {};
    let totalRevenue = 0;
    bookingsWithStatus.forEach(function(b) {
      const z = b.zone || 'Unknown';
      if (!zoneSummary[z]) zoneSummary[z] = { zone:z, count:0, revenue:0 };
      zoneSummary[z].count++;
      zoneSummary[z].revenue += parseFloat(b.rate)||0;
      totalRevenue += parseFloat(b.rate)||0;
    });

    const zones = Object.values(zoneSummary).sort(function(a,b){ return a.zone.localeCompare(b.zone); });
    const avgZoneRevenue = zones.length ? totalRevenue/zones.length : 0;

    context.res = {
      status: 200, headers: CORS,
      body: JSON.stringify({
        month, bookings: bookingsWithStatus, zones,
        summary: {
          totalBookings:   bookingsWithStatus.length,
          totalRevenue:    Math.round(totalRevenue*100)/100,
          avgZoneRevenue:  Math.round(avgZoneRevenue*100)/100,
          zoneCount:       zones.length
        }
      })
    };
  } catch(e) {
    context.log.error('getBookingsDashboard error:', e.message);
    context.res = { status:500, headers:CORS, body: JSON.stringify({ error:e.message }) };
  }
  context.done();
};
