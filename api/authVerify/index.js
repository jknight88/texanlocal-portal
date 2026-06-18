const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'e42f24e9f5cfe3558144a25a0b30c6458fc4bd5ab6a6271404a1e7b509404c72';

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

  // Get token from query param (SWA strips Authorization header)
  const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');

  if (!token) {
    context.res = { status: 401, headers: CORS, body: JSON.stringify({ error: 'No token' }) };
    context.done();
    return;
  }

  try {
    const user = jwt.verify(token, JWT_SECRET);
    context.res = {
      status: 200,
      headers: CORS,
      body: JSON.stringify({
        ok:       true,
        username: user.username,
        name:     user.name,
        role:     user.role,
        email:    user.email || ''
      })
    };
  } catch(e) {
    context.res = { status: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid token' }) };
  }
  context.done();
};
