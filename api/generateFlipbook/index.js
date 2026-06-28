// api/generateFlipbook/index.js
const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');
const { v4: uuidv4 } = require('uuid');
const STORAGE_CONN     = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER        = 'portal-data';
const CONTAINER_PROOFS = 'ad-proofs';
const CONTAINER_IMAGES = 'ad-proof-images';
const TENANT_ID        = process.env.TENANT_ID;
const CLIENT_ID        = process.env.GRAPH_CLIENT_ID;
const CLIENT_SECRET    = process.env.GRAPH_CLIENT_SECRET;
const FROM_EMAIL       = process.env.REP_EMAIL || 'josh@thetexanlocal.com';
const THUMB_HIRES      = 'c3300x1950'; // 300dpi for 11"x6.5"

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

function getSasUrl(acct, key, container, blobName, days) {
  const cred    = new StorageSharedKeyCredential(acct, key);
  const expires = new Date(Date.now() + days*24*60*60*1000);
  const t       = generateBlobSASQueryParameters(
    { containerName:container, blobName, permissions:BlobSASPermissions.parse('r'), expiresOn:expires }, cred
  ).toString();
  return 'https://'+acct+'.blob.core.windows.net/'+container+'/'+blobName+'?'+t;
}

async function getGraphToken() {
  const params = new URLSearchParams({
    grant_type:'client_credentials', client_id:CLIENT_ID,
    client_secret:CLIENT_SECRET, scope:'https://graph.microsoft.com/.default'
  });
  const res  = await fetch('https://login.microsoftonline.com/'+TENANT_ID+'/oauth2/v2.0/token',
    { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:params.toString() });
  const data = await res.json();
  if (!data.access_token) throw new Error('Graph token error');
  return data.access_token;
}

// Generate a hires thumbnail for one page and store it in ad-proof-images.
// Returns the hires blob name on success, null on failure.
async function generateHiresThumb(filesC, imgC, pdfPath, hiresName, context) {
  try {
    // Upload PDF to OneDrive temp location
    const pdfBuffer = await filesC.getBlockBlobClient(pdfPath).downloadToBuffer();
    const token     = await getGraphToken();
    const fname     = pdfPath.split('/').pop();
    const tmpPath   = 'LayoutThumbs/'+Date.now()+'_'+fname;

    const upRes = await fetch(
      'https://graph.microsoft.com/v1.0/users/'+FROM_EMAIL+'/drive/root:/'+tmpPath+':/content',
      { method:'PUT', headers:{'Authorization':'Bearer '+token,'Content-Type':'application/pdf'}, body:pdfBuffer }
    );
    if (!upRes.ok) throw new Error('OneDrive upload failed: '+upRes.status);
    const itemId = (await upRes.json()).id;

    try {
      // Fetch hires thumbnail with retries
      let thumbRes = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        await new Promise(function(r){ setTimeout(r, 3000); });
        thumbRes = await fetch(
          'https://graph.microsoft.com/v1.0/users/'+FROM_EMAIL+'/drive/items/'+itemId+'/thumbnails/0/'+THUMB_HIRES+'/content',
          { headers:{'Authorization':'Bearer '+token} }
        );
        if (thumbRes.ok) break;
        context.log('Hires thumb attempt '+(attempt+1)+' for '+fname+': '+thumbRes.status);
      }
      if (!thumbRes || !thumbRes.ok) throw new Error('Hires thumb failed after retries');

      const imgBuf = Buffer.from(await thumbRes.arrayBuffer());
      await imgC.getBlockBlobClient(hiresName).upload(imgBuf, imgBuf.length, {
        overwrite: true,
        blobHTTPHeaders: { blobContentType:'image/jpeg' }
      });
      context.log('Hires thumb generated:', hiresName);
      return hiresName;
    } finally {
      // Always clean up OneDrive temp file
      try {
        await fetch('https://graph.microsoft.com/v1.0/users/'+FROM_EMAIL+'/drive/items/'+itemId,
          { method:'DELETE', headers:{'Authorization':'Bearer '+token} });
      } catch(e) {}
    }
  } catch(e) {
    context.log.warn('Hires thumb generation failed for '+pdfPath+': '+e.message);
    return null;
  }
}

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res={status:200,headers:CORS,body:'{}'}; context.done(); return; }

  const { month, year, zone, pages, layoutTitle } = req.body || {};
  if (!month || !year || !zone || !pages || !pages.length) {
    context.res={status:400,headers:CORS,body:JSON.stringify({error:'Missing fields'})}; context.done(); return;
  }

  try {
    const conn  = parseConn();
    const acct  = conn['AccountName'];
    const key   = conn['AccountKey'];
    const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient(CONTAINER);
    const filesC    = blobSvc.getContainerClient(CONTAINER_PROOFS);
    const imgC      = blobSvc.getContainerClient(CONTAINER_IMAGES);
    await imgC.createIfNotExists();

    // ── Generate hires thumbs for any page that needs one ──────────────────
    // Only pages that have a blobPath (real uploaded PDF) and no cached _hires.jpg yet.
    // We do this before building SAS URLs so imageUrl points to a real blob.
    const hiresCache = {}; // thumbPath → hiresName (if successfully generated)

    for (const p of pages) {
      if (!p.blobPath || !p.thumbPath) continue;
      const hiresName = p.thumbPath.replace(/\.jpg$/i, '_hires.jpg');

      // Check if hires already cached
      let alreadyExists = false;
      try {
        await imgC.getBlockBlobClient(hiresName).getProperties();
        alreadyExists = true;
        context.log('Hires already cached:', hiresName);
      } catch(e) {}

      if (!alreadyExists) {
        context.log('Generating hires thumb for:', p.blobPath);
        const result = await generateHiresThumb(filesC, imgC, p.blobPath, hiresName, context);
        if (result) hiresCache[p.thumbPath] = hiresName;
      } else {
        hiresCache[p.thumbPath] = hiresName;
      }
    }

    // ── Build page list with blob names (not SAS URLs) ────────────────────
    // SAS URLs expire and cause 403s. Instead we store blob names and generate
    // fresh SAS URLs at read time in getFlipbook.
    const pagesWithUrls = pages.map(function(p) {
      // Hires blob name (generated above)
      const hiresBlobName = (p.thumbPath && hiresCache[p.thumbPath]) ? hiresCache[p.thumbPath] : null;
      // Fallback layout thumb blob name
      const thumbBlobName = p.thumbPath || null;
      // Use hires if available, otherwise layout thumb
      const imageBlobName = hiresBlobName || thumbBlobName;

      return {
        business:       p.business,
        product:        p.product,
        size:           p.size,
        imageBlobName,                // primary — hires if available, layout thumb otherwise
        thumbBlobName:  hiresBlobName ? thumbBlobName : null, // fallback only if different
        noArtwork:      !imageBlobName
      };
    });

    const shortToken = uuidv4().replace(/-/g,'').slice(0,16);
    const expiresAt  = new Date(Date.now() + 30*24*60*60*1000).toISOString();
    const now        = new Date().toISOString();
    const flipbook   = {
      token: shortToken, zone, month, year,
      layoutTitle: layoutTitle||(zone+' — '+month+'/'+year),
      pages: pagesWithUrls, createdAt: now, expiresAt, viewCount: 0
    };

    const storageKey = 'flipbooks/'+zone.replace(/[^a-z0-9]/gi,'-')+'-'+month+'-'+year+'.json';
    const buf = Buffer.from(JSON.stringify(flipbook));
    await container.getBlockBlobClient(storageKey).upload(buf, buf.length, {
      overwrite: true,
      blobHTTPHeaders: { blobContentType:'application/json' }
    });

    context.log('Flipbook generated:', shortToken, 'pages:', pagesWithUrls.length);
    context.res = { status:200, headers:CORS, body: JSON.stringify({
      ok: true, token: shortToken, expiresAt, pageCount: pagesWithUrls.length
    })};
  } catch(e) {
    context.log.error('generateFlipbook error:', e.message);
    context.res = { status:500, headers:CORS, body: JSON.stringify({ error:e.message }) };
  }
  context.done();
};
