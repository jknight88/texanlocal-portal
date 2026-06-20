// api/filesUploadFile/index.js
// Uploads PDF and immediately converts first page to JPG for email proofs
const { BlobServiceClient } = require('@azure/storage-blob');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER    = 'ad-proofs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res = { status: 200, headers: CORS, body: '{}' }; context.done(); return; }

  const body = req.body || {};
  const { filename, fileBase64, year, month } = body;

  if (!filename || !fileBase64) {
    context.res = { status: 400, headers: CORS, body: JSON.stringify({ error: 'Missing filename or file data' }) };
    context.done(); return;
  }

  if (!filename.toLowerCase().endsWith('.pdf')) {
    context.res = { status: 400, headers: CORS, body: JSON.stringify({ error: 'Only PDF files accepted' }) };
    context.done(); return;
  }

  const buffer = Buffer.from(fileBase64, 'base64');
  const sizeMB = buffer.length / (1024 * 1024);
  if (sizeMB > 100) {
    context.res = { status: 400, headers: CORS, body: JSON.stringify({ error: 'File too large (max 100MB)' }) };
    context.done(); return;
  }

  const yr       = year  || new Date().getFullYear().toString();
  const mo       = month || String(new Date().getMonth() + 1).padStart(2, '0');
  const blobPath = `${yr}/${mo}/${filename}`;

  try {
    const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = blobSvc.getContainerClient(CONTAINER);
    await container.createIfNotExists();

    // Upload the PDF
    const pdfBlob = container.getBlockBlobClient(blobPath);
    await pdfBlob.upload(buffer, buffer.length, {
      overwrite: true,
      blobHTTPHeaders: { blobContentType: 'application/pdf' }
    });

    // Preview generation moved to on-demand via generateThumb API
    // Do NOT save previews to ad-proofs container (causes them to show in file manager)
    const previewPath = null;

    context.res = {
      status: 200,
      headers: CORS,
      body: JSON.stringify({ ok: true, filename, blobPath, previewPath, sizeMB: parseFloat(sizeMB.toFixed(2)) })
    };
  } catch(e) {
    context.log.error('uploadFile error:', e.message);
    context.res = { status: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
  context.done();
};
