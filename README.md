# WinGo House AI v11

This release separates live observation from house-side research infrastructure.

## Architecture

Browser/authorized observer -> `/api/ingest` -> PostgreSQL -> immutable ledger -> research snapshot -> browser AI.

The server-side upstream collector is **disabled by default** because the upstream environment has previously returned HTTP 403. It can only be enabled where the source is authorized and reachable.

## Durable ledger

Each new issue is stored with the raw payload SHA-256 and a chained ledger record. The chain is tamper-evident: each record hash commits to the previous record hash plus the normalized evidence.

## CSPRNG reference lab

`/api/csprng-audit` creates an independent Node `crypto.randomFillSync` reference sample and compares basic digit distribution, BIG/SMALL runs, and lag-1 correlation with observed data. This is an audit/reference baseline, **not** a reconstruction of a hidden upstream generator.

## Processing state

The API maintains separate `lastCollectedIssue`, `lastAnalyzedIssue`, `lastPredictionIssue`, and `lastTimingIssue` so reopening the UI does not replay historical periods.

## Deployment

Configure `DATABASE_URL` to the existing Render PostgreSQL database. Do not delete the existing database. The frontend remains the live observer until an independent authorized continuous source is available.

For genuine 24/7 collection, use an authorized continuously running source/worker. A sleeping/free web service is not a guarantee of continuous collection.
