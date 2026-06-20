const { BlobServiceClient } = require('@azure/storage-blob');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER    = 'ad-proofs';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

function zoneAbbr(zid) { return zid.split('-').slice(1).join('').toLowerCase(); }
function pageLabel(n)   { return 'pg' + String(n).padStart(2,'0'); }

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res={status:200,headers:CORS,body:'{}'}; context.done(); return; }
  const { month, year, zoneId, layout } = req.body || {};
  if (!month || !year || !zoneId || !layout) {
    context.res={status:400,headers:CORS,body:JSON.stringify({error:'Missing fields'})}; context.done(); return;
  }
  context.res={status:200,headers:CORS,body:JSON.stringify({ok:true,message:'Export coming soon'})};
  context.done();
};
