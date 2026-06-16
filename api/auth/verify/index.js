// api/auth/verify/index.js
// GET /api/auth/verify
// Verifies JWT token from cookie or Authorization header
// Returns user info if valid

const { requireAuth, ok, err, corsOk } = require('../../shared/utils');

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { corsOk(context); return; }

  const user = requireAuth(req);
  if (!user) {
    err(context, 401, 'Unauthorized');
    return;
  }

  ok(context, {
    ok:       true,
    username: user.username,
    name:     user.name,
    role:     user.role,
    email:    user.email || ''
  });
};
