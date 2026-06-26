const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');
const STORAGE_CONN  = process.env.AZURE_STORAGE_CONNECTION_STRING;
const TENANT_ID     = process.env.TENANT_ID;
const CLIENT_ID     = process.env.GRAPH_CLIENT_ID;
const CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET;
const FROM_EMAIL    = process.env.REP_EMAIL || 'josh@thetexanlocal.com';
const CONTAINER_FILES  = 'ad-proofs';
const CONTAINER_IMAGES = 'ad-proof-images';
const CORS = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization','Content-Type':'application/json'};

// Two sizes:
//   layout thumb  — fast, small, for the drag-and-drop layout tool
//   flipbook hires — high quality, for the public flipbook viewer
const THUMB_LAYOUT   = 'large';       // ~1500px, fast, already cached for existing files
const THUMB_FLIPBOOK = 'c3300x1950';  // 300dpi for 11"x6.5", generated on flipbook creation

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

// Upload PDF to OneDrive and return the item ID
async function uploadToOneDrive(token, pdfBuffer, fname) {
  const tmpPath = 'LayoutThumbs/'+Date.now()+'_'+fname;
  const upRes   = await fetch('https://graph.microsoft.com/v1.0/users/'+FROM_EMAIL+'/drive/root:/'+tmpPath+':/content',
    { method:'PUT', headers:{'Authorization':'Bearer '+token,'Content-Type':'application/pdf'}, body:pdfBuffer });
  if (!upRes.ok) throw new Error('OneDrive upload: '+upRes.status);
  return (await upRes.json()).id;
}

// Fetch a thumbnail from OneDrive with retries
async function fetchThumb(token, itemId, size, context) {
  let thumbRes = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise(function(r){ setTimeout(r, 3000); });
    thumbRes = await fetch(
      'https://graph.microsoft.com/v1.0/users/'+FROM_EMAIL+'/drive/items/'+itemId+'/thumbnails/0/'+size+'/content',
      { headers:{'Authorization':'Bearer '+token} }
    );
    if (thumbRes.ok) break;
    if (context) context.log('Thumb attempt '+(attempt+1)+' ('+size+') failed: '+thumbRes.status);
  }
  if (!thumbRes || !thumbRes.ok) throw new Error('Thumbnail not ready after retries ('+size+'): '+(thumbRes?thumbRes.status:'no response'));
  return Buffer.from(await thumbRes.arrayBuffer());
}

// Delete OneDrive item (cleanup)
async function deleteOneDriveItem(token, itemId) {
  try {
    await fetch('https://graph.microsoft.com/v1.0/users/'+FROM_EMAIL+'/drive/items/'+itemId,
      { method:'DELETE', headers:{'Authorization':'Bearer '+token} });
  } catch(e) {}
}

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res={status:200,headers:CORS,body:'{}'}; context.done(); return; }

  const { pdfPath, hires } = req.body || {};
  if (!pdfPath) { context.res={status:400,headers:CORS,body:JSON.stringify({error:'Missing pdfPath'})}; context.done(); return; }

  // hires=true  → return high-res flipbook version (c3300x1950), stored as filename_hires.jpg
  // hires=false → return layout thumb (large ~1500px), stored as filename.jpg  (unchanged)
  const wantHires  = hires === true;
  const thumbSize  = wantHires ? THUMB_FLIPBOOK : THUMB_LAYOUT;
  const baseName   = pdfPath.replace(/\//g,'_').replace(/\.pdf$/i,'');
  const cacheName  = wantHires ? baseName+'_hires.jpg' : baseName+'.jpg';

  try {
    const conn    = parseConn();
    const acct    = conn['AccountName'];
    const key     = conn['AccountKey'];
    const blobSvc = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const filesC  = blobSvc.getContainerClient(CONTAINER_FILES);
    const imgC    = blobSvc.getContainerClient(CONTAINER_IMAGES);
    await imgC.createIfNotExists();

    // Return cached version if it exists
    try {
      await imgC.getBlockBlobClient(cacheName).getProperties();
      context.res = { status:200, headers:CORS, body: JSON.stringify({
        ok:true, url:getSasUrl(acct,key,CONTAINER_IMAGES,cacheName,7), cached:true
      })};
      context.done(); return;
    } catch(e) {}

    // Generate via OneDrive
    const pdfBuffer = await filesC.getBlockBlobClient(pdfPath).downloadToBuffer();
    const token     = await getGraphToken();
    const fname     = pdfPath.split('/').pop();
    const itemId    = await uploadToOneDrive(token, pdfBuffer, fname);

    try {
      const imgBuf = await fetchThumb(token, itemId, thumbSize, context);
      await imgC.getBlockBlobClient(cacheName).upload(imgBuf, imgBuf.length, {
        overwrite: true,
        blobHTTPHeaders: { blobContentType:'image/jpeg' }
      });
      context.res = { status:200, headers:CORS, body: JSON.stringify({
        ok:true, url:getSasUrl(acct,key,CONTAINER_IMAGES,cacheName,7), cached:false
      })};
    } finally {
      await deleteOneDriveItem(token, itemId);
    }
  } catch(e) {
    context.res = { status:500, headers:CORS, body: JSON.stringify({ error:e.message }) };
  }
  context.done();
};
