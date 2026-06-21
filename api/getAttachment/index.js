const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

function parseConn() {
  const p = {};
  STORAGE_CONN.split(';').forEach(function(s){ const i=s.indexOf('='); if(i>-1) p[s.slice(0,i)]=s.slice(i+1); });
  return p;
}

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res={status:200,headers:CORS,body:'{}'}; context.done(); return; }
  const blobName  = req.query.blobName;
  const container = req.query.container || 'ad-approvals';
  if (!blobName) { context.res={status:400,headers:CORS,body:JSON.stringify({error:'Missing blobName'})}; context.done(); return; }
  try {
    const conn = parseConn();
    const acct = conn['AccountName'];
    const key  = conn['AccountKey'];
    const cred = new StorageSharedKeyCredential(acct, key);
    const exp  = new Date(Date.now() + 60*60*1000); // 1 hour
    const tok  = generateBlobSASQueryParameters(
      { containerName:container, blobName, permissions:BlobSASPermissions.parse('r'), expiresOn:exp }, cred
    ).toString();
    const url = 'https://'+acct+'.blob.core.windows.net/'+container+'/'+blobName+'?'+tok;
    context.res = { status:200, headers:CORS, body:JSON.stringify({ url }) };
  } catch(e) {
    context.res = { status:500, headers:CORS, body:JSON.stringify({ error:e.message }) };
  }
  context.done();
};
