const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'change-me';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

module.exports = function(context, req) {
  if (req.method === 'OPTIONS') {
    context.res = { status: 200, headers: CORS_HEADERS, body: '{}' };
    context.done();
    return;
  }

  // Get token from cookie or Authorization header
  let token = null;
  const auth = req.headers && req.headers.authorization;
  const cookie = req.headers && req.headers.cookie;
  if (auth && auth.startsWith('Bearer ')) token = auth.slice(7);
  if (!token && cookie) {
    const match = cookie.match(/txl_token=([^;]+)/);
    if (match) token = match[1];
  }

  // Also check query string for token
  if (!token && req.query && req.query.token) token = req.query.token;

  if (!token) {
    context.res = { status: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Unauthorized' }) };
    context.done();
    return;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    context.res = {
      status: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ ok: true, username: payload.username, name: payload.name, role: payload.role, email: payload.email || '' })
    };
  } catch(e) {
    context.res = { status: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  context.done();
};
