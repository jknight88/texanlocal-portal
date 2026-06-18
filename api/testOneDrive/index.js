const TENANT_ID     = process.env.TENANT_ID;
const CLIENT_ID     = process.env.GRAPH_CLIENT_ID;
const CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET;
const FROM_EMAIL    = process.env.REP_EMAIL || 'josh@thetexanlocal.com';

async function getToken() {
  const params = new URLSearchParams({
    grant_type: 'client_credentials', client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET, scope: 'https://graph.microsoft.com/.default'
  });
  const res  = await fetch('https://login.microsoftonline.com/' + TENANT_ID + '/oauth2/v2.0/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString()
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Token error: ' + JSON.stringify(data));
  return data.access_token;
}

module.exports = async function(context, req) {
  const results = {};
  try {
    const token = await getToken();
    results.token = 'OK';

    // Try to get user's drive info
    const driveRes = await fetch(
      'https://graph.microsoft.com/v1.0/users/' + FROM_EMAIL + '/drive',
      { headers: { 'Authorization': 'Bearer ' + token } }
    );
    results.driveStatus = driveRes.status;
    if (driveRes.ok) {
      const driveData = await driveRes.json();
      results.driveType = driveData.driveType;
      results.driveId   = driveData.id ? driveData.id.substring(0,20) : 'none';
    } else {
      results.driveError = await driveRes.text();
    }

    // Try uploading a tiny test file
    const testContent = Buffer.from('Hello OneDrive test');
    const upRes = await fetch(
      'https://graph.microsoft.com/v1.0/users/' + FROM_EMAIL + '/drive/root:/TestUpload/test.txt:/content',
      { method: 'PUT', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'text/plain' }, body: testContent }
    );
    results.uploadStatus = upRes.status;
    if (upRes.ok) {
      const upData = await upRes.json();
      results.uploadId = upData.id ? upData.id.substring(0,20) : 'none';

      // Try thumbnail
      const thumbRes = await fetch(
        'https://graph.microsoft.com/v1.0/users/' + FROM_EMAIL + '/drive/items/' + upData.id + '/thumbnails',
        { headers: { 'Authorization': 'Bearer ' + token } }
      );
      results.thumbnailStatus = thumbRes.status;
      const thumbData = await thumbRes.json();
      results.thumbnailValue = JSON.stringify(thumbData).substring(0, 200);

      // Clean up
      await fetch(
        'https://graph.microsoft.com/v1.0/users/' + FROM_EMAIL + '/drive/items/' + upData.id,
        { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token } }
      );
      results.cleanup = 'OK';
    } else {
      results.uploadError = await upRes.text();
    }
  } catch(e) {
    results.error = e.message;
  }

  context.res = {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2)
  };
  context.done();
};
