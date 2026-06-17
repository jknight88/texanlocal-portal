// TEMPORARY DEBUG FUNCTION - remove after fixing
module.exports = function(context, req) {
  context.res = {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      TENANT_ID:        process.env.TENANT_ID ? 'SET (' + process.env.TENANT_ID.slice(0,8) + '...)' : 'MISSING',
      GRAPH_CLIENT_ID:  process.env.GRAPH_CLIENT_ID ? 'SET (' + process.env.GRAPH_CLIENT_ID.slice(0,8) + '...)' : 'MISSING',
      GRAPH_CLIENT_SECRET: process.env.GRAPH_CLIENT_SECRET ? 'SET (length:' + process.env.GRAPH_CLIENT_SECRET.length + ')' : 'MISSING',
      AZURE_STORAGE_CONNECTION_STRING: process.env.AZURE_STORAGE_CONNECTION_STRING ? 'SET' : 'MISSING',
      JWT_SECRET:       process.env.JWT_SECRET ? 'SET' : 'MISSING',
      REP_EMAIL:        process.env.REP_EMAIL || 'MISSING',
      BASE_URL:         process.env.BASE_URL  || 'MISSING',
      PORTAL_USERS:     process.env.PORTAL_USERS ? 'SET' : 'MISSING',
    })
  };
  context.done();
};
