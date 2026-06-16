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

  // Debug info
  const cookie = (req.headers && req.headers.cookie) || '';
  const auth   = (req.headers && req.headers.authorization) || '';
  
  context.log('Cookie header:', cookie ? cookie.substring(0, 50) + '...' : 'NONE');
  context.log('Auth header:', auth || 'NONE');
  context.log('JWT_SECRET set:', !!process.env.JWT_SECRET);

  // Get token from cookie
  let token = null;
  if (auth && auth.startsWith('Bearer ')) token = auth.slice(7);
  if (!token && cookie) {
    const match = cookie.match(/txl_token=([^;]+)/);
    if (match) token = match[1];
    context.log('Token from cookie:', token ? 'FOUND (' + token.substring(0, 20) + '...)' : 'NOT FOUND');
  }
  if (!token && req.query && req.query.token) token = req.query.token;

  if (!token) {
    context.log('No token found');
    context.res = { status: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'No token', debug: { cookie: cookie.substring(0,100), auth } }) };
    context.done();
    return;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    context.log('Token valid for:', payload.username);
    context.res = {
      status: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ ok: true, username: payload.username, name: payload.name, role: payload.role, email: payload.email || '' })
    };
  } catch(e) {
    context.log('JWT verify error:', e.message);
    context.res = { status: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid token: ' + e.message }) };
  }
  context.done();
};
