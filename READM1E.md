# WinGo API Proxy

This project creates a small self-hosted API endpoint that mirrors the JSON returned by the configured public WinGo history feed.

## Run

Requires Node.js 18+.

```bash
npm start
```

Then open `http://localhost:3000/`.

## Endpoints

- `GET /api/wingo` — returns the latest upstream JSON payload unchanged.
- `GET /api/status` — shows the last fetched issue, fetch timestamp, age, and upstream error state.

## Architecture

The server polls the upstream public feed every 1 second and keeps the newest successful payload in memory. The browser reads `/api/wingo`, so the frontend no longer calls the upstream feed directly.

This is a proxy/mirror, not an independent source of lottery results. It cannot manufacture or guarantee early results; any timing advantage depends on when the upstream endpoint itself exposes a result.

## Production notes

Use a reverse proxy/TLS layer and rate limiting before exposing this publicly. Respect the upstream provider's access rules and rate limits. The current implementation intentionally has no authentication because it is designed as a simple starting point.
