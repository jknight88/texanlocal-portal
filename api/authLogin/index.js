const jwt      = require('jsonwebtoken'); 
const bcrypt   = require('bcryptjs');
const JWT_SECRET  = process.env.JWT_SECRET || 'e42f24e9f5cfe3558144a25a0b30c6458fc4bd5ab6a6271404a1e7b509404c72';
const PORTAL_USERS = process.env.PORTAL_USERS;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') {
    context.res = { status: 200, headers: CORS, body: '{}' };
    context.done();
    return;
  }

  const { username, password } = req.body || {};
  if (!username || !password) {
    context.res = { status: 400, headers: CORS, body: JSON.stringify({ error: 'Username and password required' }) };
    context.done();
    return;
  }

  let users = [];
  try { users = JSON.parse(PORTAL_USERS || '[]'); } catch(e) {}

  const user = users.find(function(u) { return u.username.toLowerCase() === username.toLowerCase(); });
  if (!user) {
    context.res = { status: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid username or password' }) };
    context.done();
    return;
  }

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) {
    context.res = { status: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid username or password' }) };
    context.done();
    return;
  }

  const token = jwt.sign(
    { username: user.username, name: user.name, role: user.role, email: user.email || '' },
    JWT_SECRET,
    { expiresIn: '8h' }
  );

  context.res = {
    status: 200,
    headers: CORS,
    body: JSON.stringify({
      token,
      username: user.username,
      name:     user.name,
      role:     user.role,
      email:    user.email || ''
    })
  };
  context.done();
};
