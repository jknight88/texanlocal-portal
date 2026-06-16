module.exports = function(context, req) {
  context.res = {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, message: "API is working!" })
  };
  context.done();
};
