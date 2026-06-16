const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

module.exports = function(context, req) {
  context.res = {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Set-Cookie': 'txl_token=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'
    },
    body: JSON.stringify({ ok: true })
  };
  context.done();
};
