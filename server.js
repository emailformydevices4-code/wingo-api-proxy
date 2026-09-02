const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);

const UPSTREAM =
  'https://draw.ar-lottery01.com/WinGo/WinGo_30S/GetHistoryIssuePage.json';

const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');

let latestPayload = null;
let latestFetchedAt = 0;
let lastUpstreamIssue = null;
let upstreamError = null;
let fetching = false;

/*
  Timing monitor:
  Records the first time our API proxy sees each issue.
*/
const timingHistory = new Map();

async function fetchUpstream() {
  if (fetching) return;

  fetching = true;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);

    const response = await fetch(
      UPSTREAM + '?ts=' + Date.now(),
      {
        signal: controller.signal,
        headers: {
          accept: 'application/json, text/plain, */*'
        },
        cache: 'no-store'
      }
    );

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`Upstream HTTP ${response.status}`);
    }

    const payload = await response.json();
    const list = payload?.data?.list || [];

    const fetchedAt = Date.now();

    latestPayload = payload;
    latestFetchedAt = fetchedAt;
    upstreamError = null;

    if (list.length > 0) {
      const latest = list[0];
      const issue = String(latest.issueNumber);

      if (issue !== lastUpstreamIssue) {
        lastUpstreamIssue = issue;

        if (!timingHistory.has(issue)) {
          timingHistory.set(issue, {
            issue,
            number: latest.number,
            color: latest.color,
            firstSeenAt: new Date(fetchedAt).toISOString(),
            firstSeenMs: fetchedAt
          });

          console.log(
            `[NEW RESULT] issue=${issue} number=${latest.number} firstSeen=${new Date(fetchedAt).toISOString()}`
          );
        }
      }

      /*
        Keep only the latest 100 timing records.
      */
      while (timingHistory.size > 100) {
        const oldest = timingHistory.keys().next().value;
        timingHistory.delete(oldest);
      }
    }
  } catch (error) {
    upstreamError = error.message;
    console.error('[UPSTREAM ERROR]', error.message);
  } finally {
    fetching = false;
  }
}

/*
  Poll upstream every second.
*/
fetchUpstream();
setInterval(fetchUpstream, 1000);

const server = http.createServer((req, res) => {
  if (req.method !== 'GET') {
    res.writeHead(405, {
      'content-type': 'application/json; charset=utf-8'
    });

    return res.end(JSON.stringify({
      error: 'Method not allowed'
    }));
  }

  const url = new URL(
    req.url,
    `http://${req.headers.host || 'localhost'}`
  );

  /*
    Frontend
  */
  if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.readFile(INDEX_FILE, (err, data) => {
      if (err) {
        res.writeHead(500, {
          'content-type': 'text/plain; charset=utf-8'
        });

        return res.end('Frontend unavailable');
      }

      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store, no-cache, must-revalidate'
      });

      res.end(data);
    });

    return;
  }

  /*
    Main API endpoint
  */
  if (url.pathname === '/api/wingo') {
    if (!latestPayload) {
      res.writeHead(503, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      });

      return res.end(JSON.stringify({
        error: 'Feed not ready'
      }));
    }

    const list = latestPayload?.data?.list || [];
    const latest = list[0] || {};

    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-feed-fetched-at': new Date(latestFetchedAt).toISOString(),
      'x-feed-age-ms': String(Date.now() - latestFetchedAt),
      'x-feed-issue': String(latest.issueNumber || '')
    });

    return res.end(JSON.stringify(latestPayload));
  }

  /*
    Status endpoint
  */
  if (url.pathname === '/api/status') {
    const list = latestPayload?.data?.list || [];
    const latest = list[0] || null;

    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    });

    return res.end(JSON.stringify({
      ok: Boolean(latestPayload),
      fetchedAt: latestFetchedAt
        ? new Date(latestFetchedAt).toISOString()
        : null,
      ageMs: latestFetchedAt
        ? Date.now() - latestFetchedAt
        : null,
      latestIssue: latest?.issueNumber || null,
      latestNumber: latest?.number ?? null,
      upstreamError
    }));
  }

  /*
    Timing endpoint
  */
  if (url.pathname === '/api/timing') {
    const records = Array.from(timingHistory.values())
      .sort((a, b) => b.firstSeenMs - a.firstSeenMs);

    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    });

    return res.end(JSON.stringify({
      ok: true,
      count: records.length,
      records
    }));
  }

  /*
    404
  */
  res.writeHead(404, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });

  res.end(JSON.stringify({
    error: 'Not found'
  }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `WinGo API proxy running on port ${PORT}`
  );
});