// api/trackEmailOpen/index.js — returns 1x1 pixel and logs the open
const { BlobServiceClient } = require('@azure/storage-blob');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;

// 1x1 transparent GIF
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');

module.exports = async function(context, req) {
  const trackingId = req.query.id || '';

  // Update email log record
  if (trackingId) {
    try {
      const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
      const container = blobSvc.getContainerClient('portal-data');
      const names = [];
      for await (const b of container.listBlobsFlat({ prefix:'email-log/' })) {
        if (b.name.endsWith('.json')) names.push(b.name);
      }
      for (const name of names) {
        try {
          const blob = container.getBlockBlobClient(name);
          const buf  = await blob.downloadToBuffer();
          const entry = JSON.parse(buf.toString());
          if (entry.trackingId === trackingId) {
            if (!entry.openedAt) entry.openedAt = new Date().toISOString();
            entry.openCount = (entry.openCount||0) + 1;
            entry.lastOpenedAt = new Date().toISOString();
            const newBuf = Buffer.from(JSON.stringify(entry));
            await blob.upload(newBuf, newBuf.length, { overwrite:true, blobHTTPHeaders:{blobContentType:'application/json'} });
            break;
          }
        } catch(e) {}
      }
    } catch(e) {}
  }

  context.res = {
    status: 200,
    headers: { 'Content-Type':'image/gif', 'Cache-Control':'no-cache, no-store, must-revalidate', 'Access-Control-Allow-Origin':'*' },
    body: PIXEL.toString('base64'),
    isRaw: false
  };
  context.done();
};
