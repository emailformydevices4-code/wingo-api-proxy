const http = require("http");
const { chromium } = require("playwright");

const PORT = Number(process.env.PORT || 10000);
const TARGET_URL = process.env.UPSTREAM_URL ||
  "https://draw.ar-lottery01.com/WinGo/WinGo_30S/GetHistoryIssuePage.json?ts=" + Date.now();

let busy = false;

async function runBrowserDiagnostic() {
  const started = Date.now();
  const result = {
    ok: false,
    targetUrl: TARGET_URL,
    startedAt: new Date().toISOString(),
    browser: "chromium",
    mode: "normal-browser-diagnostic",
    bypassAttempted: false
  };

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    });

    const context = await browser.newContext({
      javaScriptEnabled: true,
      viewport: { width: 1280, height: 720 }
    });

    const page = await context.newPage();
    const responses = [];

    page.on("response", response => {
      if (response.url().includes("draw.ar-lottery01.com/WinGo/WinGo_30S/GetHistoryIssuePage.json")) {
        responses.push({
          url: response.url(),
          status: response.status(),
          contentType: response.headers()["content-type"] || null
        });
      }
    });

    await page.goto(TARGET_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    }).catch(err => {
      result.gotoError = String(err && err.message || err);
    });

    await page.waitForTimeout(4000);

    result.pageTitle = await page.title().catch(() => "");
    result.pageUrl = page.url();
    result.pageTextPreview = ((await page.locator("body").innerText().catch(() => "")) || "").slice(0, 1500);
    result.responses = responses.slice(-10);

    const cookies = await context.cookies().catch(() => []);
    result.cookies = cookies.map(c => ({
      name: c.name,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite
    }));

    result.elapsedMs = Date.now() - started;
    result.ok = true;
    return result;
  } catch (err) {
    result.error = String(err && err.message || err);
    result.elapsedMs = Date.now() - started;
    return result;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (req.url === "/api/health") {
    res.writeHead(200);
    return res.end(JSON.stringify({ ok: true, browserDiagnostic: true }));
  }

  if (req.url === "/api/browser-diagnostic") {
    if (busy) {
      res.writeHead(409);
      return res.end(JSON.stringify({ ok: false, error: "Diagnostic already running" }));
    }
    busy = true;
    try {
      const out = await runBrowserDiagnostic();
      res.writeHead(200);
      res.end(JSON.stringify(out, null, 2));
    } finally {
      busy = false;
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ ok: false, error: "Not found" }));
}).listen(PORT, "0.0.0.0", () => {
  console.log(`Server-browser diagnostic listening on ${PORT}`);
});
