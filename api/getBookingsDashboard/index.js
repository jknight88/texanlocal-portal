// api/getBookingsDashboard/index.js
// Returns bookings for a given month with zone summaries and renewal alerts
const { BlobServiceClient } = require('@azure/storage-blob');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER    = 'portal-data';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res={status:200,headers:CORS,body:'{}'}; context.done(); return; }

  const month = req.query.month || '';  // YYYY-MM
  const view  = req.query.view  || 'month'; // 'month' or 'renewals'

  try {
    const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient(CONTAINER);
    await container.createIfNotExists();

    // Parallel fetch all bookings
    const names = [];
    for await (const b of container.listBlobsFlat({ prefix:'bookings/' })) {
      if (b.name.endsWith('.json')) names.push(b.name);
    }

    const allBookings = [];
    const batchSize = 25;
    for (let i=0; i<names.length; i+=batchSize) {
      const batch = names.slice(i, i+batchSize);
      const results = await Promise.all(batch.map(async function(name) {
        try {
          const buf = await container.getBlockBlobClient(name).downloadToBuffer();
          return JSON.parse(buf.toString());
        } catch(e) { return null; }
      }));
      results.forEach(function(b){ if(b) allBookings.push(b); });
    }

    if (view === 'renewals') {
      // Find bookings that are the LAST month of their contract, expiring in next 60 days
      const now    = new Date();
      const in30   = new Date(now); in30.setDate(now.getDate()+30);
      const in60   = new Date(now); in60.setDate(now.getDate()+60);

      const renewals = allBookings.filter(function(b) {
        if (b.status === 'cancelled') return false;
        if (b.termIndex !== b.totalTermMonths) return false; // only last month of term
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

    // Monthly view
    const filtered = month
      ? allBookings.filter(function(b){ return b.monthYear === month && b.status !== 'cancelled'; })
      : allBookings.filter(function(b){ return b.status !== 'cancelled'; });

    filtered.sort(function(a,b){
      return (a.zone||'').localeCompare(b.zone||'') || (a.business||'').localeCompare(b.business||'');
    });

    // Zone summaries
    const zoneSummary = {};
    let totalRevenue = 0;
    filtered.forEach(function(b) {
      const z = b.zone || 'Unknown';
      if (!zoneSummary[z]) zoneSummary[z] = { zone:z, count:0, revenue:0, bookings:[] };
      zoneSummary[z].count++;
      zoneSummary[z].revenue += parseFloat(b.rate) || 0;
      zoneSummary[z].bookings.push(b);
      totalRevenue += parseFloat(b.rate) || 0;
    });

    const zones = Object.values(zoneSummary).sort(function(a,b){ return a.zone.localeCompare(b.zone); });
    const avgZoneRevenue = zones.length ? totalRevenue / zones.length : 0;

    context.res = {
      status: 200, headers: CORS,
      body: JSON.stringify({
        month, bookings: filtered, zones,
        summary: {
          totalBookings: filtered.length,
          totalRevenue:  Math.round(totalRevenue*100)/100,
          avgZoneRevenue: Math.round(avgZoneRevenue*100)/100,
          zoneCount: zones.length
        }
      })
    };
  } catch(e) {
    context.log.error('getBookingsDashboard error:', e.message);
    context.res = { status:500, headers:CORS, body: JSON.stringify({ error: e.message }) };
  }
  context.done();
};
