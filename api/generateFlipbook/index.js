// api/generateFlipbook/index.js
// Validates by calling authVerify internally — avoids JWT_SECRET mismatch
const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');
const { v4: uuidv4 } = require('uuid');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const BASE_URL     = process.env.BASE_URL || 'https://portal.thetexanlocal.com';
const CONTAINER    = 'portal-data';
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

function extractToken(req) {
  const auth   = (req.headers && req.headers['authorization']) || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const cookie = (req.headers && req.headers['cookie']) || '';
  const cm = cookie.match(/txl_token=([^;]+)/);
  if (cm) return decodeURIComponent(cm[1]).trim();
  if (req.query && req.query.token) return decodeURIComponent(req.query.token).trim();
  if (req.body && req.body._authToken) return req.body._authToken.trim();
  return '';
}

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res={status:200,headers:CORS,body:'{}'}; context.done(); return; }

  const token = extractToken(req);
  if (!token) {
    context.res={status:401,headers:CORS,body:JSON.stringify({error:'No token'})}; context.done(); return;
  }

  // Validate by calling authVerify — uses the same JWT_SECRET already working
  try {
    const verifyRes = await fetch(BASE_URL+'/api/authVerify?token='+encodeURIComponent(token));
    if (!verifyRes.ok) {
      const vd = await verifyRes.json().catch(function(){ return {}; });
      context.res={status:401,headers:CORS,body:JSON.stringify({error:'Unauthorized: '+(vd.error||verifyRes.status)})}; context.done(); return;
    }
    const user = await verifyRes.json();
    if (!user || user.role !== 'admin') {
      context.res={status:403,headers:CORS,body:JSON.stringify({error:'Admin only'})}; context.done(); return;
    }
  } catch(e) {
    context.log.error('authVerify call failed:', e.message);
    context.res={status:500,headers:CORS,body:JSON.stringify({error:'Auth check failed: '+e.message})}; context.done(); return;
  }

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

    const pagesWithUrls = pages.map(function(p) {
      let imageUrl = null;
      if (p.thumbPath) { try { imageUrl = getSasUrl(acct, key, 'ad-proof-images', p.thumbPath, 30); } catch(e) {} }
      if (!imageUrl && p.blobPath) { try { imageUrl = getSasUrl(acct, key, 'ad-proofs', p.blobPath, 30); } catch(e) {} }
      return { business:p.business, product:p.product, size:p.size, imageUrl, noArtwork:!imageUrl };
    });

    const shortToken = uuidv4().replace(/-/g,'').slice(0,16);
    const expiresAt  = new Date(Date.now() + 30*24*60*60*1000).toISOString();
    const now        = new Date().toISOString();
    const flipbook   = { token:shortToken, zone, month, year, layoutTitle:layoutTitle||(zone+' — '+month+'/'+year), pages:pagesWithUrls, createdAt:now, expiresAt, viewCount:0 };

    const storageKey = 'flipbooks/'+zone.replace(/[^a-z0-9]/gi,'-')+'-'+month+'-'+year+'.json';
    const buf = Buffer.from(JSON.stringify(flipbook));
    await container.getBlockBlobClient(storageKey).upload(buf, buf.length, { overwrite:true, blobHTTPHeaders:{blobContentType:'application/json'} });

    context.log('Flipbook generated:', shortToken, 'pages:', pagesWithUrls.length);
    context.res = { status:200, headers:CORS, body: JSON.stringify({ ok:true, token:shortToken, expiresAt, pageCount:pagesWithUrls.length }) };
  } catch(e) {
    context.log.error('generateFlipbook storage error:', e.message);
    context.res = { status:500, headers:CORS, body: JSON.stringify({ error:e.message }) };
  }
  context.done();
};
