// api/filesMoveFile/index.js
// Moves a PDF from one month folder to another within the ad-proofs container
const { BlobServiceClient } = require('@azure/storage-blob');
const jwt = require('jsonwebtoken');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const JWT_SECRET   = process.env.JWT_SECRET;
const CONTAINER    = 'ad-proofs';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res={status:200,headers:CORS,body:'{}'}; context.done(); return; }

  // Auth check
  try {
    const cookie = (req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('txl_token='));
    const token  = cookie ? cookie.split('=')[1] : null;
    if (!token) throw new Error('No token');
    jwt.verify(token, JWT_SECRET);
  } catch(e) {
    context.res={status:401,headers:CORS,body:JSON.stringify({error:'Unauthorized'})}; context.done(); return;
  }

  const { sourcePath, targetYear, targetMonth } = req.body || {};
  if (!sourcePath || !targetYear || !targetMonth) {
    context.res={status:400,headers:CORS,body:JSON.stringify({error:'Missing sourcePath, targetYear or targetMonth'})}; context.done(); return;
  }

  // sourcePath = "2026/08/BlushFiberCo_0726_FP.pdf"
  const parts    = sourcePath.split('/');
  const filename = parts[parts.length - 1];
  const destPath = targetYear + '/' + targetMonth + '/' + filename;

  if (sourcePath === destPath) {
    context.res={status:400,headers:CORS,body:JSON.stringify({error:'Source and destination are the same'})}; context.done(); return;
  }

  try {
    const blobSvc = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient(CONTAINER);

    const sourceBlob = container.getBlockBlobClient(sourcePath);
    const destBlob   = container.getBlockBlobClient(destPath);

    // Copy source to destination
    const copyResult = await destBlob.beginCopyFromURL(sourceBlob.url);
    await copyResult.pollUntilDone();

    // Delete source after successful copy
    await sourceBlob.delete();

    context.log(`Moved ${sourcePath} → ${destPath}`);
    context.res = { status:200, headers:CORS, body: JSON.stringify({ ok:true, destPath }) };
  } catch(e) {
    context.log.error('filesMoveFile error:', e.message);
    context.res = { status:500, headers:CORS, body: JSON.stringify({ error:e.message }) };
  }
  context.done();
};
