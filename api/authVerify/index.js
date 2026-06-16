const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'e42f24e9f5cfe3558144a25a0b30c6458fc4bd5ab6a6271404a1e7b509404c72';

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

  // Get token from Authorization header OR cookie OR query string
  let token = null;
  
  const auth = (req.headers && req.headers.authorization) || '';
  if (auth && auth.startsWith('Bearer ')) token = auth.slice(7);
  
  if (!token) {
    const cookie = (req.headers && req.headers.cookie) || '';
    const match = cookie.match(/txl_token=([^;]+)/);
    if (match) token = match[1];
  }
  
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
