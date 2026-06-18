const { BlobServiceClient } = require('@azure/storage-blob');
const { v4: uuidv4 } = require('uuid');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER    = 'portal-data';
const CORS = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization','Content-Type':'application/json' };

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res = { status:200, headers:CORS, body:'{}' }; context.done(); return; }
  try {
    const blobSvc = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const c = blobSvc.getContainerClient(CONTAINER);
    await c.createIfNotExists();
    const blob = c.getBlockBlobClient('prospects.json');
    let prospects = [];
    try { prospects = JSON.parse((await blob.downloadToBuffer()).toString()); } catch(e) {}

    const body = req.body || {};
    const now  = new Date().toISOString();
    let returnId = body.id;

    if (body.id) {
      prospects = prospects.map(function(p) {
        if (p.id !== body.id) return p;
        return Object.assign({}, p, body, { updatedAt: now });
      });
    } else {
      const id = uuidv4();
      returnId  = id;
      prospects.push(Object.assign({ id, activity:[], createdAt:now, updatedAt:now, status:'new' }, body));
    }

    const buf = Buffer.from(JSON.stringify(prospects));
    await blob.upload(buf, buf.length, { overwrite:true, blobHTTPHeaders:{ blobContentType:'application/json' } });
    context.res = { status:200, headers:CORS, body: JSON.stringify({ ok:true, id: returnId }) };
  } catch(e) {
    context.res = { status:500, headers:CORS, body: JSON.stringify({ error: e.message }) };
  }
  context.done();
};
