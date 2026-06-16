module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') {
    context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{}' };
    return;
  }
  context.res = {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, message: 'API is working', timestamp: new Date().toISOString() })
  };
};
