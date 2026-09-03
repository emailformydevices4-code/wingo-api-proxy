# WinGo API v2

Server-side persistent collector/API for the WinGo public JSON feed.

## Features
- 1-second server-side polling
- Issue-number deduplication
- PostgreSQL persistence via `DATABASE_URL`
- JSON fallback for local development / persistent disk
- Persistent processing state: collected/analyzed/prediction issues
- 3-second-cycle timing telemetry
- `/api/health`, `/api/status`, `/api/state`, `/api/wingo`, `/api/history`, `/api/timing`
- `/api/csprng-audit` reference layer using Node crypto
- Authorized `/api/ingest` fallback when a legitimate client can retrieve the feed

## Render
Render's normal filesystem is ephemeral. Use Render Postgres for durable data. Free web services can sleep, so true 24/7 collection requires continuously running compute (for example a paid service/background worker).

## Environment
`DATABASE_URL` = Render Postgres connection string
`INGEST_SECRET` = secret for POST endpoints
`UPSTREAM_URL` = default WinGo JSON endpoint
`POLL_MS` = 1000
`PERIOD_SEC` = 30
`MAX_HISTORY` = 10000
`TIMING_LIMIT` = 5000

## Browser rule
On startup, read `/api/state`. Historical results remain available, but the browser should only invoke analysis when `latestIssue !== lastAnalyzedIssue`. After successful analysis call `/api/mark-analyzed`.

## CSPRNG note
The CSPRNG module is a statistical/reference audit, not a recovered replica of the upstream generator. Public outputs alone do not establish the hidden server implementation or state.
