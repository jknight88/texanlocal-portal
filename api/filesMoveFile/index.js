// api/filesMoveFile/index.js
// Moves a PDF from one month folder to another within the ad-proofs container
const { BlobServiceClient } = require('@azure/storage-blob');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER    = 'ad-proofs';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res={status:200,headers:CORS,body:'{}'}; context.done(); return; }

  const { sourcePath, targetYear, targetMonth } = req.body || {};
  if (!sourcePath || !targetYear || !targetMonth) {
    context.res={status:400,headers:CORS,body:JSON.stringify({error:'Missing sourcePath, targetYear or targetMonth'})}; context.done(); return;
  }

  const parts    = sourcePath.split('/');
  const filename = parts[parts.length - 1];
  const destPath = targetYear + '/' + targetMonth + '/' + filename;

  if (sourcePath === destPath) {
    context.res={status:400,headers:CORS,body:JSON.stringify({error:'Source and destination are the same'})}; context.done(); return;
  }

  try {
    const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient(CONTAINER);

    const sourceBlob = container.getBlockBlobClient(sourcePath);
    const destBlob   = container.getBlockBlobClient(destPath);

    // Copy then delete
    const copyOp = await destBlob.beginCopyFromURL(sourceBlob.url);
    await copyOp.pollUntilDone();
    await sourceBlob.delete();

    context.log('Moved ' + sourcePath + ' to ' + destPath);
    context.res = { status:200, headers:CORS, body: JSON.stringify({ ok:true, destPath }) };
  } catch(e) {
    context.log.error('filesMoveFile error:', e.message);
    context.res = { status:500, headers:CORS, body: JSON.stringify({ error:e.message }) };
  }
  context.done();
};
