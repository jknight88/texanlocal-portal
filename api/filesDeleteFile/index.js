// api/files/deleteFile/index.js
// DELETE /api/files/delete?path=2026/06/ChemDry_0626_FP.pdf
// Auth: admin only

const { requireAuth, getContainer, corsOk, ok, err } = require('../shared/utils');
const CONTAINER = 'ad-proofs';

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { corsOk(context); return; }

  const user = requireAuth(req, ['admin']);
  if (!user) { err(context, 401, 'Unauthorized'); return; }

  const blobPath = req.query.path || (req.body && req.body.path);
  if (!blobPath) { err(context, 400, 'Missing path'); return; }

  if (blobPath.includes('..') || blobPath.startsWith('/')) {
    err(context, 400, 'Invalid path');
    return;
  }

  try {
    const container = getContainer(CONTAINER);
    await container.getBlockBlobClient(blobPath).delete();
    context.log(`File deleted by ${user.username}: ${blobPath}`);
    ok(context, { ok: true, deleted: blobPath });
  } catch(e) {
    context.log.error('deleteFile error:', e.message);
    err(context, 500, e.message);
  }
};
