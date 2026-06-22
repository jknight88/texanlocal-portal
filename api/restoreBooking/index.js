// api/restoreBooking/index.js
// Restores a skipped or cancelled booking back to booked status
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

  const { bookingId, logId } = req.body || {};
  if (!bookingId) {
    context.res={status:400,headers:CORS,body:JSON.stringify({error:'Missing bookingId'})}; context.done(); return;
  }

  try {
    const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient(CONTAINER);
    const blob      = container.getBlockBlobClient('bookings/'+bookingId+'.json');
    const buf       = await blob.downloadToBuffer();
    const booking   = JSON.parse(buf.toString());
    const now       = new Date().toISOString();
    const wasStatus = booking.status;

    booking.status     = 'booked';
    booking.updatedAt  = now;
    booking.restoredAt = now;
    booking.reason     = '';
    delete booking.actionDate;

    const newBuf = Buffer.from(JSON.stringify(booking));
    await blob.upload(newBuf, newBuf.length, { overwrite:true, blobHTTPHeaders:{blobContentType:'application/json'} });

    // Log the restore
    const logEntry = {
      logId:      uuidv4(),
      bookingId:  booking.bookingId,
      contractId: booking.contractId,
      business:   booking.business,
      zone:       booking.zone,
      product:    booking.product,
      monthYear:  booking.monthYear,
      rate:       booking.rate,
      action:     'restored',
      reason:     'Restored from '+wasStatus,
      actionDate: now,
      termIndex:  booking.termIndex,
      totalTermMonths: booking.totalTermMonths
    };
    const logBuf = Buffer.from(JSON.stringify(logEntry));
    await container.getBlockBlobClient('booking-log/'+logEntry.logId+'.json')
      .upload(logBuf, logBuf.length, { overwrite:true, blobHTTPHeaders:{blobContentType:'application/json'} });

    // Delete the original log entry if logId provided
    if (logId) {
      try { await container.getBlockBlobClient('booking-log/'+logId+'.json').delete(); } catch(e) {}
    }

    // If was skipped — find and remove the makeup month that was added
    if (wasStatus === 'skipped') {
      const bkNames = [];
      for await (const b of container.listBlobsFlat({ prefix:'bookings/' })) {
        if (b.name.endsWith('.json')) bkNames.push(b.name);
      }
      // Find makeup booking (notes contains 'Makeup month — skipped YYYY-MM')
      const makeupNote = 'Makeup month — skipped '+booking.monthYear;
      for (let i=0; i<bkNames.length; i+=20) {
        const batch = bkNames.slice(i, i+20);
        await Promise.all(batch.map(async function(name) {
          try {
            const b = JSON.parse((await container.getBlockBlobClient(name).downloadToBuffer()).toString());
            if (b.contractId === booking.contractId && (b.notes||'').includes(makeupNote)) {
              await container.getBlockBlobClient(name).delete();
              // Reduce totalTermMonths on all other bookings
              const allBk = [];
              for await (const ab of container.listBlobsFlat({ prefix:'bookings/' })) {
                if (ab.name.endsWith('.json')) allBk.push(ab.name);
              }
              await Promise.all(allBk.map(async function(abn) {
                try {
                  const abBlob = container.getBlockBlobClient(abn);
                  const abData = JSON.parse((await abBlob.downloadToBuffer()).toString());
                  if (abData.contractId === booking.contractId) {
                    abData.totalTermMonths = Math.max(1, (abData.totalTermMonths||12) - 1);
                    const abBuf = Buffer.from(JSON.stringify(abData));
                    await abBlob.upload(abBuf, abBuf.length, { overwrite:true, blobHTTPHeaders:{blobContentType:'application/json'} });
                  }
                } catch(e) {}
              }));
            }
          } catch(e) {}
        }));
      }
    }

    context.res = { status:200, headers:CORS, body: JSON.stringify({ ok:true }) };
  } catch(e) {
    context.log.error('restoreBooking error:', e.message);
    context.res = { status:500, headers:CORS, body: JSON.stringify({ error:e.message }) };
  }
  context.done();
};
