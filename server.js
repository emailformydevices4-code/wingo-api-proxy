const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const UPSTREAM =
  'https://draw.ar-lottery01.com/WinGo/WinGo_30S/GetHistoryIssuePage.json';

const PUBLIC_DIR = path.join(__dirname, 'public');

let latestPayload = null;
let latestFetchedAt = 0;
let lastUpstreamIssue = null;
let upstreamError = null;

async function fetchUpstream() {
  const url = `${UPSTREAM}?ts=${Date.now()}`;
  const started = Date.now();

  try {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: {
        accept: 'application/json,text/plain,*/*',
        'user-agent': 'WinGo-Feed-Proxy/1.0'
      },
      signal: AbortSignal.timeout(2500)
    });

    if (!response.ok) {
      throw new Error(`Upstream HTTP ${response.status}`);
    }

    const payload = await response.json();
    const list = payload?.data?.list;

    if (!Array.isArray(list) || !list.length) {
      throw new Error('Upstream returned an empty list');
    }

    latestPayload = payload;
    latestFetchedAt = Date.now();
    lastUpstreamIssue = String(list[0]?.issueNumber ?? '');
    upstreamError = null;

    console.log(
      `[UPSTREAM] issue=${lastUpstreamIssue} latency=${Date.now() - started}ms`
    );
  } catch (err) {
    upstreamError = String(err?.message || err);
    console.warn(`[UPSTREAM] ${upstreamError}`);
  }
}

fetchUpstream();
setInterval(fetchUpstream, 1000);

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control':
      'no-store, no-cache, must-revalidate, proxy-revalidate',
    pragma: 'no-cache',
    expires: '0',
    'access-control-allow-origin': '*',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders
  });

  res.end(body);
}

function serveIndex(res) {
  fs.readFile(
    path.join(PUBLIC_DIR, 'index.html'),
    (err, data) => {
      if (err) {
        return sendJson(res, 500, {
          error: 'frontend unavailable'
        });
      }

      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
      });

      res.end(data);
    }
  );
}

const server = http.createServer(async (req, res) => {
  const u = new URL(
    req.url,
    `http://${req.headers.host}`
  );

  if (
    req.method === 'GET' &&
    u.pathname === '/api/wingo'
  ) {
    if (!latestPayload) {
      return sendJson(res, 503, {
        ok: false,
        error: 'Waiting for upstream feed',
        upstreamError
      });
    }

    return sendJson(res, 200, latestPayload, {
      'x-feed-fetched-at':
        new Date(latestFetchedAt).toISOString(),
      'x-feed-age-ms':
        String(Date.now() - latestFetchedAt),
      'x-feed-issue':
        lastUpstreamIssue || ''
    });
  }

  if (
    req.method === 'GET' &&
    u.pathname === '/api/status'
  ) {
    return sendJson(res, 200, {
      ok: !!latestPayload,
      upstream: UPSTREAM,
      lastIssue: lastUpstreamIssue,
      fetchedAt: latestFetchedAt
        ? new Date(latestFetchedAt).toISOString()
        : null,
      ageMs: latestFetchedAt
        ? Date.now() - latestFetchedAt
        : null,
      error: upstreamError
    });
  }

  if (
    req.method === 'GET' &&
    (u.pathname === '/' ||
      u.pathname === '/index.html')
  ) {
    return serveIndex(res);
  }

  sendJson(res, 404, {
    error: 'Not found'
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `WinGo API proxy running on port ${PORT}`
  );
});