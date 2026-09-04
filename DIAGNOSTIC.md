# House AI v21.1 — 403 Diagnostic Build

This build adds two read-only diagnostics:

- `GET /api/upstream-diagnostic` — performs one ordinary server-side request to `UPSTREAM_URL` and returns status, headers, timing and a short body preview.
- `GET /api/egress` — reports the public egress IP seen by ipify (if that endpoint is reachable).

This is for diagnosing legitimate access restrictions. It does not rotate proxies, spoof browser fingerprints, bypass WAF/CAPTCHA, or otherwise circumvent access controls.

## Render environment

Set `UPSTREAM_URL` if needed. Otherwise the default is the WinGo history endpoint already used by the project.

After deploy, open:

- `/api/health`
- `/api/egress`
- `/api/upstream-diagnostic`

Compare the diagnostic response with the successful browser request. If the upstream owner supports IP allowlisting, provide the Render outbound range shown in the Render dashboard. Render documents that outbound IPs are visible under Service → Connect → Outbound.
