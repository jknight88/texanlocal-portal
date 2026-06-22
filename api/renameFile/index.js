// api/renameFile/index.js
// Copies blob to new name, deletes old blob and its thumbnail cache
const { BlobServiceClient } = require('@azure/storage-blob');
const STORAGE_CONN     = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER        = 'ad-proofs';
const CONTAINER_IMAGES = 'ad-proof-images';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res={status:200,headers:CORS,body:'{}'}; context.done(); return; }

  const { oldPath, newName } = req.body || {};
  if (!oldPath || !newName) { context.res={status:400,headers:CORS,body:JSON.stringify({error:'Missing oldPath or newName'})}; context.done(); return; }

  try {
    const blobSvc  = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const proofsC  = blobSvc.getContainerClient(CONTAINER);
    const imagesC  = blobSvc.getContainerClient(CONTAINER_IMAGES);

    // Build new path: same folder, new filename
    const dir     = oldPath.substring(0, oldPath.lastIndexOf('/')+1);
    const newPath = dir + newName;

    if (oldPath === newPath) { context.res={status:200,headers:CORS,body:JSON.stringify({ok:true})}; context.done(); return; }

    // Copy to new name
    const srcBlob  = proofsC.getBlockBlobClient(oldPath);
    const destBlob = proofsC.getBlockBlobClient(newPath);
    const srcUrl   = srcBlob.url;
    await destBlob.beginCopyFromURL(srcUrl);

    // Wait for copy to complete
    let copied = false;
    for (let i=0; i<10; i++) {
      await new Promise(function(r){ setTimeout(r,500); });
      const props = await destBlob.getProperties();
      if (props.copyStatus === 'success') { copied=true; break; }
    }
    if (!copied) throw new Error('Copy timed out');

    // Delete old blob
    await srcBlob.delete();

    // Delete old thumbnail cache
    const oldCacheName = oldPath.replace(/\//g,'_').replace(/\.pdf$/i,'.jpg');
    try { await imagesC.getBlockBlobClient(oldCacheName).delete(); } catch(e) {}
    // Also delete new name cache if it exists (stale)
    const newCacheName = newPath.replace(/\//g,'_').replace(/\.pdf$/i,'.jpg');
    try { await imagesC.getBlockBlobClient(newCacheName).delete(); } catch(e) {}

    context.log('Renamed:', oldPath, '->', newPath);
    context.res = { status:200, headers:CORS, body:JSON.stringify({ ok:true, newPath }) };
  } catch(e) {
    context.log.error('renameFile error:', e.message);
    context.res = { status:500, headers:CORS, body:JSON.stringify({ error:e.message }) };
  }
  context.done();
};
