const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');

const server = http.createServer((req, res) => {
  if (req.method !== 'GET') {
    res.writeHead(405, {
      'content-type': 'application/json; charset=utf-8'
    });
    return res.end(JSON.stringify({
      error: 'Method not allowed'
    }));
  }

  if (req.url === '/' || req.url === '/index.html') {
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

  res.writeHead(404, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });

  res.end(JSON.stringify({
    error: 'Not found'
  }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`WinGo Predictor running on port ${PORT}`);
});