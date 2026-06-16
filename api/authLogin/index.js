// api/auth/login/index.js
// POST /api/auth/login  { username, password }
// Returns JWT token on success
// Roles: admin | rep | designer

const bcrypt = require('bcryptjs');
const { signToken, corsOk, ok, err, CORS_HEADERS } = require('../shared/utils');

// Users are stored as env vars — no hardcoded credentials
// Format: USERS_JSON = '[{"username":"sherry","passwordHash":"$2b$...","role":"designer","name":"Sherry Justice"}]'
// Admin uses Entra ID on the frontend — this handles designer + rep simple login

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { corsOk(context); return; }

  const body     = req.body || {};
  const username = (body.username || '').trim().toLowerCase();
  const password = body.password || '';

  if (!username || !password) {
    err(context, 400, 'Username and password required');
    return;
  }

  try {
    // Load users from environment variable (set in Azure App Settings)
    const usersJson = process.env.PORTAL_USERS;
    if (!usersJson) {
      err(context, 500, 'User configuration not found');
      return;
    }

    const users = JSON.parse(usersJson);
    const user  = users.find(u => u.username.toLowerCase() === username);

    if (!user) {
      // Delay to prevent timing attacks
      await new Promise(r => setTimeout(r, 500));
      err(context, 401, 'Invalid username or password');
      return;
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      await new Promise(r => setTimeout(r, 500));
      err(context, 401, 'Invalid username or password');
      return;
    }

    const token = signToken({
      username: user.username,
      name:     user.name,
      role:     user.role,
      email:    user.email || ''
    });

    // Set secure HTTP-only cookie + return token in body
    context.res = {
      status:  200,
      headers: {
        ...CORS_HEADERS,
        'Set-Cookie': `txl_token=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`
      },
      body: JSON.stringify({
        ok:       true,
        token,
        name:     user.name,
        role:     user.role,
        username: user.username
      })
    };

  } catch(e) {
    context.log.error('Login error:', e.message);
    err(context, 500, 'Login failed');
  }
};
