// api/generateFlipbook/index.js
const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const JWT_SECRET   = process.env.JWT_SECRET || 'change-me-in-keyvault';
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
  const token   = generateBlobSASQueryParameters(
    { containerName:container, blobName, permissions:BlobSASPermissions.parse('r'), expiresOn:expires }, cred
  ).toString();
  return 'https://'+acct+'.blob.core.windows.net/'+container+'/'+blobName+'?'+token;
}

function extractToken(req) {
  // 1. Authorization header
  const auth = (req.headers && req.headers['authorization']) || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  // 2. Cookie
  const cookie = (req.headers && req.headers['cookie']) || '';
  const cm = cookie.match(/txl_token=([^;]+)/);
  if (cm) return decodeURIComponent(cm[1]).trim();
  // 3. Query string
  if (req.query && req.query.token) return decodeURIComponent(req.query.token).trim();
  // 4. Body
  if (req.body && req.body._authToken) return req.body._authToken.trim();
  return '';
}

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res={status:200,headers:CORS,body:'{}'}; context.done(); return; }

  const rawToken = extractToken(req);
  context.log('generateFlipbook auth - token length:', rawToken ? rawToken.length : 0, 'JWT_SECRET length:', JWT_SECRET.length);

  if (!rawToken) {
    context.res={status:401,headers:CORS,body:JSON.stringify({error:'No token provided'})}; context.done(); return;
  }

  let decoded;
  try {
    decoded = jwt.verify(rawToken, JWT_SECRET);
  } catch(e) {
    context.log.error('JWT verify failed:', e.message, '| secret length:', JWT_SECRET.length, '| token prefix:', rawToken.slice(0,20));
    context.res={status:401,headers:CORS,body:JSON.stringify({error:'Invalid token: '+e.message})}; context.done(); return;
  }

  if (!decoded || decoded.role !== 'admin') {
    context.res={status:403,headers:CORS,body:JSON.stringify({error:'Forbidden — admin only'})}; context.done(); return;
  }

  const { month, year, zone, pages, layoutTitle } = req.body || {};
  if (!month || !year || !zone || !pages || !pages.length) {
    context.res={status:400,headers:CORS,body:JSON.stringify({error:'Missing month, year, zone, or pages'})}; context.done(); return;
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
    context.log.error('generateFlipbook error:', e.message);
    context.res = { status:500, headers:CORS, body: JSON.stringify({ error:e.message }) };
  }
  context.done();
};
