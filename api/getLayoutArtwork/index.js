const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER_FILES  = 'ad-proofs';
const CONTAINER_IMAGES = 'ad-proof-images';
const CORS = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization','Content-Type':'application/json'};

function parseConn() {
  const p = {};
  STORAGE_CONN.split(';').forEach(function(s) { const i=s.indexOf('='); if(i>-1) p[s.slice(0,i)]=s.slice(i+1); });
  return p;
}

function getSasUrl(acct, key, container, blobName, days) {
  const sharedKey = new StorageSharedKeyCredential(acct, key);
  const expiresOn = new Date(Date.now() + days*24*60*60*1000);
  const token     = generateBlobSASQueryParameters(
    { containerName:container, blobName, permissions:BlobSASPermissions.parse('r'), expiresOn }, sharedKey
  ).toString();
  return 'https://'+acct+'.blob.core.windows.net/'+container+'/'+blobName+'?'+token;
}

function parseZones(zstr) {
  if (!zstr) return [];
  const s = zstr.replace(/^Z/i,'');
  const result = [];
  s.split(',').forEach(function(part) {
    if (part.includes('-')) {
      const b=part.split('-'); for(let n=parseInt(b[0]);n<=parseInt(b[1]);n++) result.push(n);
    } else { const n=parseInt(part); if(!isNaN(n)) result.push(n); }
  });
  return result;
}

function parseFilename(fname) {
  const noExt = fname.replace(/\.pdf$/i,'');
  const parts = noExt.split('_');
  if (parts.length < 2) return null;
  let size='', zoneStr='';
  for (let i=0;i<parts.length;i++) {
    if (/^(FP|HP|2P|2P1|2P2|FC|BP)$/i.test(parts[i])) size = parts[i].toUpperCase();
    if (/^Z\d/i.test(parts[i]))          zoneStr = parts[i];
  }
  if (!size) return null;
  return { business:parts[0], size, zoneStr, zones:parseZones(zoneStr) };
}

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res={status:200,headers:CORS,body:'{}'}; context.done(); return; }
  const month = req.query.month || '';
  const year  = req.query.year  || '';
  if (!month || !year) { context.res={status:400,headers:CORS,body:JSON.stringify({error:'Missing month/year'})}; context.done(); return; }
  try {
    const conn   = parseConn();
    const acct   = conn['AccountName'];
    const key    = conn['AccountKey'];
    const blobSvc = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const filesC  = blobSvc.getContainerClient(CONTAINER_FILES);
    const imgC    = blobSvc.getContainerClient(CONTAINER_IMAGES);

    const prefix = year + '/' + month + '/';
    const files  = [];

    for await (const blob of filesC.listBlobsFlat({ prefix })) {
      const fname  = blob.name.replace(prefix,'');
      if (fname.includes('/')) continue;
      const parsed = parseFilename(fname);
      if (!parsed) continue;

      // Look for cached thumbnail - try multiple naming patterns
      let thumbUrl = null;
      const candidates = [
        blob.name.replace(/\//g,'_').replace(/\.pdf$/i,'.jpg'),
        fname.replace(/\.pdf$/i,'.jpg')
      ];
      for (const candidate of candidates) {
        try {
          await imgC.getBlockBlobClient(candidate).getProperties();
          thumbUrl = getSasUrl(acct, key, CONTAINER_IMAGES, candidate, 7);
          break;
        } catch(e) {}
      }

      files.push({
        id: blob.name, filename: fname, path: blob.name,
        business: parsed.business, size: parsed.size,
        zoneStr: parsed.zoneStr, zones: parsed.zones,
        thumbUrl, hasThumb: !!thumbUrl
      });
    }

    context.res = { status:200, headers:CORS, body: JSON.stringify({ files }) };
  } catch(e) {
    context.res = { status:500, headers:CORS, body: JSON.stringify({ error: e.message }) };
  }
  context.done();
};
