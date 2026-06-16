const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'e42f24e9f5cfe3558144a25a0b30c6458fc4bd5ab6a6271404a1e7b509404c72';
const BASE_URL = process.env.BASE_URL || 'https://portal.thetexanlocal.com';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Credentials': 'true',
  'Content-Type': 'application/json'
};

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') {
    context.res = { status: 200, headers: CORS_HEADERS, body: '{}' };
    context.done();
    return;
  }

  const body = req.body || {};
  const username = (body.username || '').trim().toLowerCase();
  const password = body.password || '';

  if (!username || !password) {
    context.res = { status: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Username and password required' }) };
    context.done();
    return;
  }

  try {
    const usersJson = process.env.PORTAL_USERS;
    if (!usersJson) {
      context.res = { status: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'User configuration not found' }) };
      context.done();
      return;
    }

    const users = JSON.parse(usersJson);
    const user = users.find(u => u.username.toLowerCase() === username);

    if (!user) {
      await new Promise(r => setTimeout(r, 500));
      context.res = { status: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid username or password' }) };
      context.done();
      return;
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      await new Promise(r => setTimeout(r, 500));
      context.res = { status: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid username or password' }) };
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
      headers: {
        ...CORS_HEADERS,
        'Set-Cookie': `txl_token=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`
      },
      body: JSON.stringify({ ok: true, token, name: user.name, role: user.role, username: user.username })
    };
    context.done();

  } catch(e) {
    context.log.error('Login error:', e.message);
    context.res = { status: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Login failed' }) };
    context.done();
  }
};
