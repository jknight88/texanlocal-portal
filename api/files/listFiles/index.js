// api/files/listFiles/index.js
// GET /api/files/list?year=2026&month=06
// Lists all PDF files in ad-proofs/{year}/{month}/
// Auth: admin, rep, designer (read-only for designer)

const { requireAuth, getContainer, corsOk, ok, err } = require('../../shared/utils');
const CONTAINER = 'ad-proofs';

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { corsOk(context); return; }

  const user = requireAuth(req, ['admin', 'rep', 'designer']);
  if (!user) { err(context, 401, 'Unauthorized'); return; }

  const year  = req.query.year  || new Date().getFullYear().toString();
  const month = req.query.month || String(new Date().getMonth() + 1).padStart(2, '0');
  const prefix = `${year}/${month}/`;

  try {
    const container = getContainer(CONTAINER);
    await container.createIfNotExists();

    const files = [];
    for await (const blob of container.listBlobsFlat({ prefix })) {
      files.push({
        name:         blob.name.replace(prefix, ''),
        fullPath:     blob.name,
        size:         blob.properties.contentLength,
        sizeLabel:    formatSize(blob.properties.contentLength),
        uploadedAt:   blob.properties.lastModified,
        contentType:  blob.properties.contentType || 'application/pdf'
      });
    }

    // Sort alphabetically by name
    files.sort((a, b) => a.name.localeCompare(b.name));

    ok(context, { files, year, month, prefix });
  } catch(e) {
    context.log.error('listFiles error:', e.message);
    err(context, 500, e.message);
  }
};

function formatSize(bytes) {
  if (!bytes) return '—';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? mb.toFixed(1) + 'MB' : Math.round(bytes / 1024) + 'KB';
}
