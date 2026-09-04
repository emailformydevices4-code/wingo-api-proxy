# Server-Browser Diagnostic — Docker

The previous native Render build failed because installing Playwright OS dependencies
requires system package privileges. This version uses the official Playwright Docker
image, which includes Chromium and its browser system dependencies.

## Render settings

Repository: `om-digital-works-group/wingo-api-proxy`
Branch: `main`
Root Directory: `server-browser`
Language: `Docker`
Dockerfile Path: `Dockerfile`

Because this is Docker, do NOT enter a Build Command or Start Command.
The Dockerfile supplies the start command.

Use Free compute for this one-time diagnostic. Do not connect PostgreSQL and do not
add DATABASE_URL.

After deployment:
1. Open `/api/health`
2. Open `/api/browser-diagnostic`
3. Send the complete JSON response.

This is a controlled diagnostic. It does not solve CAPTCHAs, spoof fingerprints,
rotate proxies, replay clearance cookies, or bypass Cloudflare protections.
