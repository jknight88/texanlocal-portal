 # Texan Local Portal

Unified internal platform for The Texan Local.

**URL:** `portal.thetexanlocal.com`

---

## Modules

| Module | URL | Access |
|--------|-----|--------|
| Home | `/home` | admin, rep |
| Enrollment & E-Sign | `/enrollment` | admin, rep |
| Ad Approvals | `/approvals` | admin, rep |
| File Manager | `/files` | admin, rep |
| Designer Upload | `/upload` | designer |
| Dashboard | `/dashboard` | admin, rep |

---

## Azure Environment Variables

Set these in **Azure Static Web App → Configuration → Application Settings**:

| Variable | Description |
|----------|-------------|
| `AZURE_STORAGE_CONNECTION_STRING` | Connection string for `texanlocalenroll` storage account |
| `TENANT_ID` | `0e65dbc2-40cd-4dd9-a71f-9ce087852341` |
| `GRAPH_CLIENT_ID` | `f6c0d6df-40f2-4866-a8a2-003d1ebef5ac` |
| `GRAPH_CLIENT_SECRET` | Your Azure app client secret |
| `JWT_SECRET` | Random 64-char string (generate with `openssl rand -hex 32`) |
| `REP_EMAIL` | `josh@thetexanlocal.com` |
| `BASE_URL` | `https://portal.thetexanlocal.com` |
| `DASHBOARD_KEY` | Password for enrollment dashboard (keep existing value) |
| `PORTAL_USERS` | JSON array of portal users (see below) |
| `NOTIFY_EMAIL` | `josh@thetexanlocal.com` |

---

## PORTAL_USERS Format

Generate password hash with Node.js:
```js
const bcrypt = require('bcryptjs');
console.log(bcrypt.hashSync('your-password-here', 10));
```

Then set `PORTAL_USERS` to:
```json
[
  {
    "username": "sherry",
    "passwordHash": "$2b$10$...(generated hash)...",
    "role": "designer",
    "name": "Sherry Justice",
    "email": "sherry@example.com"
  }
]
```

---

## GoDaddy DNS Setup

Add this CNAME record in GoDaddy:

| Type | Name | Value |
|------|------|-------|
| CNAME | portal | `[your-azure-static-web-app].azurestaticapps.net` |

Azure will automatically provision an SSL certificate.

---

## GitHub Setup

1. Create repo `texanlocal-portal` under `jknight88`
2. Push this code to `main` branch
3. In Azure Static Web App → Settings → GitHub Actions — connect to `jknight88/texanlocal-portal`
4. Copy the deployment token to GitHub repo → Settings → Secrets → `AZURE_STATIC_WEB_APPS_API_TOKEN`

Every push to `main` auto-deploys.

---

## Blob Storage Containers

Add these to the existing `texanlocalenroll` storage account:

| Container | Purpose |
|-----------|---------|
| `enrollments` | Existing enrollment records |
| `enrollments-trash` | Existing trash |
| `ad-approvals` | Ad approval send records |
| `ad-proofs` | PDF files organized as `{year}/{month}/{filename}` |
