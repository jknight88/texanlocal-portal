// api/auth/logout/index.js
// POST /api/auth/logout
// Clears the auth cookie

const { corsOk, ok, CORS_HEADERS } = require('../shared/utils');

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { corsOk(context); return; }
  context.res = {
    status:  200,
    headers: {
      ...CORS_HEADERS,
      'Set-Cookie': 'txl_token=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'
    },
    body: JSON.stringify({ ok: true })
  };
};
