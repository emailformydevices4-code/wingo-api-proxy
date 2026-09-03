# WinGo House AI v12 — House Research Ledger

This package upgrades the v11 foundation into a durable research ledger focused on observable Big/Small behaviour. It does **not** claim access to hidden server logic or participant-selection data.

## What v12 adds
- PostgreSQL-backed result ledger with SHA-256 hash chaining.
- `/api/ledger-verify` to independently verify the chain.
- Rolling behavioural windows: 1m, 3m, 5m, 10m, 15m, 30m, 60m.
- Big/Small distribution, entropy, runs, lag-1 correlation, streaks and transition matrices.
- Pattern/hypothesis bank for sequences up to length 4, with minimum support.
- Chronological walk-forward comparison of neutral, recent-frequency, persistence and transition models using Brier score and accuracy.
- Research snapshots persisted per latest issue.
- 3-second timing telemetry remains separate from predictive evidence.
- CSPRNG reference/audit module remains independent and does not attempt to reconstruct a hidden upstream generator.
- Browser ingestion remains the authorized observation path when the hosted server cannot fetch the upstream feed.

## Important scientific rules
1. Big/Small is the primary target. Number, parity and colour are contextual and must not be double-counted as independent evidence when derived from the same digit.
2. A pattern is an association, not a causal explanation.
3. Short windows are descriptive; they do not prove predictive edge.
4. Evaluation is time-ordered to avoid future-data leakage.
5. Weak, unstable or contradictory evidence should lower confidence or produce abstention.
6. No participant-selection counts are fabricated. If the official feed does not expose them, they remain unknown.

## Render
Use the existing PostgreSQL database via `DATABASE_URL`. Do not create a second database. `SERVER_COLLECTOR_ENABLED=false` is intentional because the previously observed hosted environment returned HTTP 403 from the upstream; the browser observer can ingest data when it is authorized to see it. A continuously running Render Background Worker is the appropriate architecture for always-on collection when the upstream permits it. Render documents background workers as continuously running services.

Render free web services can sleep and their local filesystem is ephemeral, so PostgreSQL is the durable store.

## Endpoints
- GET `/api/health`
- GET `/api/state`
- GET `/api/history?limit=100`
- GET `/api/timing?limit=100`
- GET `/api/ledger?limit=50`
- GET `/api/ledger-verify`
- GET `/api/research`
- GET `/api/research-snapshot?limit=1000`
- GET `/api/csprng-audit?limit=1000`
- POST `/api/ingest`
- POST `/api/mark-analyzed`
- POST `/api/mark-prediction`

## Data integrity
Each result is deduplicated by issue. The PostgreSQL primary key protects uniqueness, and each ledger record contains the previous record hash plus its own SHA-256 hash. The verification endpoint recomputes the chain without modifying it.

## No guarantees
This is a statistical research and observability system. It cannot guarantee future Big/Small outcomes or reconstruct a hidden server generator from public outputs.


## v13 House Day + Fast Decision Path

- House Day is 05:30 IST → 05:30 IST.
- A House Day contains 2,880 30-second periods.
- The permanent PostgreSQL result/ledger history is never deleted at reset.
- Current-day counters roll over automatically at 05:30 IST.
- The live browser decision path does not wait for PostgreSQL, deep research, or CSPRNG network calls.
- New observations are analyzed immediately; persistence and research refresh run asynchronously.
- `/api/house-day` exposes the current House Day and current-day counters.
- Existing databases are migrated with additive `ALTER TABLE ... IF NOT EXISTS` statements; no database recreation is required.
