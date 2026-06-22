// api/skipBooking/index.js
const { BlobServiceClient } = require('@azure/storage-blob');
const { v4: uuidv4 } = require('uuid');
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

  const { bookingId, action, reason } = req.body || {};
  if (!bookingId || !action) {
    context.res={status:400,headers:CORS,body:JSON.stringify({error:'Missing bookingId or action'})}; context.done(); return;
  }

  try {
    const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient(CONTAINER);
    const blob      = container.getBlockBlobClient('bookings/'+bookingId+'.json');
    const buf       = await blob.downloadToBuffer();
    const booking   = JSON.parse(buf.toString());
    const now       = new Date().toISOString();

    booking.status     = action === 'skip' ? 'skipped' : 'cancelled';
    booking.updatedAt  = now;
    booking.actionDate = now;
    booking.reason     = reason || '';

    // Save log entry
    const logEntry = {
      logId:      uuidv4(),
      bookingId:  booking.bookingId,
      contractId: booking.contractId,
      business:   booking.business,
      zone:       booking.zone,
      product:    booking.product,
      monthYear:  booking.monthYear,
      rate:       booking.rate,
      action:     booking.status,
      reason:     reason || '',
      actionDate: now,
      termIndex:  booking.termIndex,
      totalTermMonths: booking.totalTermMonths
    };
    const logBuf = Buffer.from(JSON.stringify(logEntry));
    await container.getBlockBlobClient('booking-log/'+logEntry.logId+'.json')
      .upload(logBuf, logBuf.length, { overwrite:true, blobHTTPHeaders:{blobContentType:'application/json'} });

    // Save updated booking
    const newBuf = Buffer.from(JSON.stringify(booking));
    await blob.upload(newBuf, newBuf.length, { overwrite:true, blobHTTPHeaders:{blobContentType:'application/json'} });

    let makeupBooking = null;

    if (action === 'skip') {
      // Load all active bookings for this contract to find the last month
      const bkNames = [];
      for await (const b of container.listBlobsFlat({ prefix:'bookings/' })) {
        if (b.name.endsWith('.json')) bkNames.push(b.name);
      }

      const contractBookings = [];
      const batchSize = 20;
      for (let i=0; i<bkNames.length; i+=batchSize) {
        const batch = bkNames.slice(i, i+batchSize);
        const results = await Promise.all(batch.map(async function(name) {
          try { return JSON.parse((await container.getBlockBlobClient(name).downloadToBuffer()).toString()); }
          catch(e) { return null; }
        }));
        results.forEach(function(b) {
          if (b && b.contractId === booking.contractId && b.status !== 'cancelled') contractBookings.push(b);
        });
      }

      // Find last month
      contractBookings.sort(function(a,b){ return a.monthYear < b.monthYear ? 1 : -1; });
      const last = contractBookings[0];

      if (last) {
        const [ly, lm] = last.monthYear.split('-').map(Number);
        const next      = new Date(ly, lm, 1);
        const nextYear  = next.getFullYear();
        const nextMonth = String(next.getMonth()+1).padStart(2,'0');
        const newTotal  = (booking.totalTermMonths||12) + 1;

        makeupBooking = {
          bookingId:       uuidv4(),
          contractId:      booking.contractId,
          business:        booking.business,
          zone:            booking.zone,
          product:         booking.baseProduct || booking.product,
          baseProduct:     booking.baseProduct || booking.product,
          monthYear:       nextYear+'-'+nextMonth,
          year:            String(nextYear),
          month:           nextMonth,
          rate:            booking.rate,
          isComboMonth:    false,
          termIndex:       newTotal,
          totalTermMonths: newTotal,
          status:          'booked',
          artworkFile:     null,
          notes:           'Makeup month — skipped '+booking.monthYear,
          createdAt:       now
        };

        const mkBuf = Buffer.from(JSON.stringify(makeupBooking));
        await container.getBlockBlobClient('bookings/'+makeupBooking.bookingId+'.json')
          .upload(mkBuf, mkBuf.length, { overwrite:true, blobHTTPHeaders:{blobContentType:'application/json'} });

        // Update totalTermMonths on all other bookings in this contract
        for (const cb of contractBookings) {
          if (cb.bookingId === booking.bookingId) continue;
          try {
            const cbBlob = container.getBlockBlobClient('bookings/'+cb.bookingId+'.json');
            const cbData = JSON.parse((await cbBlob.downloadToBuffer()).toString());
            cbData.totalTermMonths = newTotal;
            const cbNew = Buffer.from(JSON.stringify(cbData));
            await cbBlob.upload(cbNew, cbNew.length, { overwrite:true, blobHTTPHeaders:{blobContentType:'application/json'} });
          } catch(e) {}
        }
      }
    }

    context.res = { status:200, headers:CORS, body: JSON.stringify({ ok:true, status:booking.status, makeupBooking }) };
  } catch(e) {
    context.log.error('skipBooking error:', e.message);
    context.res = { status:500, headers:CORS, body: JSON.stringify({ error:e.message }) };
  }
  context.done();
};
