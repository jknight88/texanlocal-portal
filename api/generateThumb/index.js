const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');
const STORAGE_CONN  = process.env.AZURE_STORAGE_CONNECTION_STRING;
const TENANT_ID     = process.env.TENANT_ID;
const CLIENT_ID     = process.env.GRAPH_CLIENT_ID;
const CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET;
const FROM_EMAIL    = process.env.REP_EMAIL || 'josh@thetexanlocal.com';
const CONTAINER_FILES  = 'ad-proofs';
const CONTAINER_IMAGES = 'ad-proof-images';
const CORS = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization','Content-Type':'application/json'};

function parseConn() {
  const p = {};
  STORAGE_CONN.split(';').forEach(function(s) { const i=s.indexOf('='); if(i>-1) p[s.slice(0,i)]=s.slice(i+1); });
  return p;
}
function getSasUrl(acct, key, container, blobName, days) {
  const sk = new StorageSharedKeyCredential(acct, key);
  const exp = new Date(Date.now() + days*24*60*60*1000);
  const tok = generateBlobSASQueryParameters(
    { containerName:container, blobName, permissions:BlobSASPermissions.parse('r'), expiresOn:exp }, sk
  ).toString();
  return 'https://'+acct+'.blob.core.windows.net/'+container+'/'+blobName+'?'+tok;
}
async function getGraphToken() {
  const params = new URLSearchParams({ grant_type:'client_credentials', client_id:CLIENT_ID, client_secret:CLIENT_SECRET, scope:'https://graph.microsoft.com/.default' });
  const res  = await fetch('https://login.microsoftonline.com/'+TENANT_ID+'/oauth2/v2.0/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:params.toString() });
  const data = await res.json();
  if (!data.access_token) throw new Error('Token error');
  return data.access_token;
}

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res={status:200,headers:CORS,body:'{}'}; context.done(); return; }
  const { pdfPath } = req.body || {};
  if (!pdfPath) { context.res={status:400,headers:CORS,body:JSON.stringify({error:'Missing pdfPath'})}; context.done(); return; }
  try {
    const conn     = parseConn();
    const acct     = conn['AccountName'];
    const key      = conn['AccountKey'];
    const blobSvc  = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const filesC   = blobSvc.getContainerClient(CONTAINER_FILES);
    const imgC     = blobSvc.getContainerClient(CONTAINER_IMAGES);
    await imgC.createIfNotExists();
    const cacheName = pdfPath.replace(/\//g,'_').replace(/\.pdf$/i,'.jpg');

    // Return cached if exists
    try {
      await imgC.getBlockBlobClient(cacheName).getProperties();
      context.res={status:200,headers:CORS,body:JSON.stringify({ok:true,url:getSasUrl(acct,key,CONTAINER_IMAGES,cacheName,7),cached:true})};
      context.done(); return;
    } catch(e) {}

    // Generate via OneDrive
    const pdfBuffer = await filesC.getBlockBlobClient(pdfPath).downloadToBuffer();
    const token     = await getGraphToken();
    const fname     = pdfPath.split('/').pop();
    const tmpPath   = 'LayoutThumbs/'+Date.now()+'_'+fname;
    const upRes     = await fetch('https://graph.microsoft.com/v1.0/users/'+FROM_EMAIL+'/drive/root:/'+tmpPath+':/content',
      { method:'PUT', headers:{'Authorization':'Bearer '+token,'Content-Type':'application/pdf'}, body:pdfBuffer });
    if (!upRes.ok) throw new Error('OneDrive upload: '+upRes.status);
    const itemId = (await upRes.json()).id;
    await new Promise(function(r){ setTimeout(r, 3000); });
    try {
      const thumbRes = await fetch('https://graph.microsoft.com/v1.0/users/'+FROM_EMAIL+'/drive/items/'+itemId+'/thumbnails/0/large/content',
        { headers:{'Authorization':'Bearer '+token} });
      if (!thumbRes.ok) throw new Error('Thumb: '+thumbRes.status);
      const imgBuf = Buffer.from(await thumbRes.arrayBuffer());
      await imgC.getBlockBlobClient(cacheName).upload(imgBuf, imgBuf.length, { overwrite:true, blobHTTPHeaders:{blobContentType:'image/jpeg'} });
      const url = getSasUrl(acct, key, CONTAINER_IMAGES, cacheName, 7);
      context.res={status:200,headers:CORS,body:JSON.stringify({ok:true,url,cached:false})};
    } finally {
      try { await fetch('https://graph.microsoft.com/v1.0/users/'+FROM_EMAIL+'/drive/items/'+itemId,{method:'DELETE',headers:{'Authorization':'Bearer '+token}}); } catch(e){}
    }
  } catch(e) {
    context.res={status:500,headers:CORS,body:JSON.stringify({error:e.message})};
  }
  context.done();
};
