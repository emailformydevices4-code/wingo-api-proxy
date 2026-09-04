# House AI v21 — Clean-Slate Continuous Capture

## Important
This build changes RESET behavior intentionally: `/api/reset` now **TRUNCATEs PostgreSQL run data** (`house_results`, `house_timing`, `house_ledger`, `house_runs`) and creates one fresh active run. This is destructive and is only triggered after the UI confirmation.

## Capture / sync
- Browser observes the authorized public feed.
- Every valid result returned by each poll is placed into an idempotent sync queue.
- The queue is flushed to PostgreSQL continuously, on reconnect, and when the page becomes visible again.
- PostgreSQL primary keys prevent duplicate issues.
- Browser localStorage is disposable cache only.
- The build does not claim guaranteed 24/7 collection if Android suspends the browser; when execution resumes it reconciles the feed data it can observe.

## Research
- v7.1 remains the Champion.
- PDF 720-rule challenger remains separate.
- Research modules must be evaluated chronologically without future leakage.

## Deployment
Upload the complete project to the existing Render/GitLab service. Do not create a second service. Keep the existing `DATABASE_URL` environment variable.
