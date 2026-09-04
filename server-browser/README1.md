# Server-Browser Diagnostic

Controlled diagnostic only: launches normal headless Chromium with JavaScript enabled and checks the upstream response.

It does NOT solve CAPTCHAs, spoof fingerprints, rotate proxies, replay clearance cookies, or bypass Cloudflare protections.

## Render
Build command:
`npm install && npx playwright install --with-deps chromium`

Start command:
`npm start`

Optional environment variable:
`UPSTREAM_URL=https://draw.ar-lottery01.com/WinGo/WinGo_30S/GetHistoryIssuePage.json`

After deployment:
1. Open `/api/health`
2. Open `/api/browser-diagnostic`
3. Send the complete JSON result.

This diagnostic does not modify or reset PostgreSQL.
