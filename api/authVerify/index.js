// v3 - force redeploy
const jwt = require('jsonwebtoken');
const SECRET = 'e42f24e9f5cfe3558144a25a0b30c6458fc4bd5ab6a6271404a1e7b509404c72';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

module.exports = function(context, req) {
  if (req.method === 'OPTIONS') {
    context.res = { status: 200, headers: CORS, body: '{}' };
    context.done();
    return;
  }

  const token = (req.query && req.query.token) || '';

  if (!token) {
    context.res = { status: 401, headers: CORS, body: JSON.stringify({ error: 'No token' }) };
    context.done();
    return;
  }

  try {
    const payload = jwt.verify(token, SECRET);
    context.res = {
      status: 200,
      headers: CORS,
      body: JSON.stringify({ ok: true, username: payload.username, name: payload.name, role: payload.role, email: payload.email || '' })
    };
  } catch(e) {
    context.res = { status: 401, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
  context.done();
};
