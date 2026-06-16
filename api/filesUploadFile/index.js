// api/files/uploadFile/index.js
// POST /api/files/upload
// Body: { filename, fileBase64, contentType, year, month, uploadedBy }
// Stores file at ad-proofs/{year}/{month}/{filename}
// Auth: admin, designer

const { requireAuth, getContainer, corsOk, ok, err, sendEmail, emailWrapper, FROM_EMAIL } = require('../shared/utils');
const CONTAINER  = 'ad-proofs';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || FROM_EMAIL;
const MAX_SIZE_MB   = 100;

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { corsOk(context); return; }

  const user = requireAuth(req, ['admin', 'designer']);
  if (!user) { err(context, 401, 'Unauthorized'); return; }

  const body = req.body || {};
  const { filename, fileBase64, contentType, year, month } = body;

  if (!filename || !fileBase64) {
    err(context, 400, 'Missing filename or file data');
    return;
  }

  // Validate filename follows convention
  if (!filename.endsWith('.pdf') && !filename.endsWith('.PDF')) {
    err(context, 400, 'Only PDF files are accepted');
    return;
  }

  // Check file size
  const buffer  = Buffer.from(fileBase64, 'base64');
  const sizeMB  = buffer.length / (1024 * 1024);
  if (sizeMB > MAX_SIZE_MB) {
    err(context, 400, `File too large (${sizeMB.toFixed(1)}MB). Maximum is ${MAX_SIZE_MB}MB`);
    return;
  }

  const yr  = year  || new Date().getFullYear().toString();
  const mo  = month || String(new Date().getMonth() + 1).padStart(2, '0');
  const blobPath = `${yr}/${mo}/${filename}`;

  try {
    const container = getContainer(CONTAINER);
    await container.createIfNotExists();

    const blob = container.getBlockBlobClient(blobPath);
    await blob.upload(buffer, buffer.length, {
      overwrite: true,
      blobHTTPHeaders: {
        blobContentType: contentType || 'application/pdf',
        blobContentDisposition: `inline; filename="${filename}"`
      },
      metadata: {
        uploadedBy:  user.name || user.username,
        uploadedAt:  new Date().toISOString(),
        originalName: filename
      }
    });

    // Notify admin that new file was uploaded
    if (user.role === 'designer') {
      try {
        const html = emailWrapper(`
          <h2 style="color:#00205B;margin:0 0 16px">New Ad Proof Uploaded</h2>
          <p style="font-size:14px;color:#333;line-height:1.6">
            <strong>${user.name || user.username}</strong> uploaded a new file to the portal.
          </p>
          <table style="font-size:13px;color:#333;margin-top:16px;width:100%">
            <tr><td style="padding:4px 0;color:#666;width:120px">File:</td><td><strong>${filename}</strong></td></tr>
            <tr><td style="padding:4px 0;color:#666">Month:</td><td>${mo}/${yr}</td></tr>
            <tr><td style="padding:4px 0;color:#666">Size:</td><td>${sizeMB.toFixed(1)}MB</td></tr>
            <tr><td style="padding:4px 0;color:#666">Uploaded by:</td><td>${user.name || user.username}</td></tr>
            <tr><td style="padding:4px 0;color:#666">Time:</td><td>${new Date().toLocaleString('en-US', {timeZone:'America/Chicago'})}</td></tr>
          </table>
          <div style="margin-top:24px">
            <a href="${process.env.BASE_URL || 'https://portal.thetexanlocal.com'}/files"
               style="background:#00205B;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;font-size:13px;font-weight:700">
              View File Manager
            </a>
          </div>
        `);
        await sendEmail(NOTIFY_EMAIL, 'Josh Knight', `New Ad Proof Uploaded — ${filename}`, html);
      } catch(emailErr) {
        context.log.warn('Notification email failed:', emailErr.message);
      }
    }

    ok(context, {
      ok:       true,
      filename,
      blobPath,
      sizeMB:   parseFloat(sizeMB.toFixed(2)),
      uploadedBy: user.name || user.username
    });

  } catch(e) {
    context.log.error('uploadFile error:', e.message);
    err(context, 500, e.message);
  }
};
