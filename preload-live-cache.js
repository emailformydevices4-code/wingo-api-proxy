// Server preload: stabilize live reads and patch the legacy browser so it cannot bypass
// the server-authoritative /api/wingo/live path with direct Supabase polling.
const nativeFetch = globalThis.fetch;
const fs = require('fs');
const path = require('path');

if (typeof nativeFetch === 'function' && !globalThis.__WINGO_FETCH_CACHE__) {
  const cache = new Map();
  const TTL_MS = 900;
  globalThis.fetch = async function cachedFetch(input, init = {}) {
    const method = String(init?.method || (input && input.method) || 'GET').toUpperCase();
    const url = typeof input === 'string' ? input : String(input?.url || input);
    const isGet = method === 'GET';
    const isDataRead = isGet && (/\.supabase\.co\/rest\/v1\//.test(url) || /draw\.ar-lottery01\.com\/WinGo\/WinGo_30S\//.test(url));
    if (!isDataRead) return nativeFetch(input, init);
    const now = Date.now();
    const hit = cache.get(url);
    if (hit && now - hit.at < TTL_MS) return hit.response.clone();
    try {
      const response = await nativeFetch(input, init);
      if (response.ok) cache.set(url, { at: Date.now(), response: response.clone() });
      return response;
    } catch (err) {
      if (hit) return hit.response.clone();
      throw err;
    }
  };
  globalThis.__WINGO_FETCH_CACHE__ = true;
}

// The shipped legacy index.html contains its own direct-Supabase api() function.
// Patch that browser fetch path before the page's scripts execute. The browser gets
// table-shaped responses from the already-authoritative /api/wingo/live payload.
if (!globalThis.__WINGO_BROWSER_BRIDGE__) {
  const nativeReadFileSync = fs.readFileSync;
  const BRIDGE = `<script>(function(){'use strict';if(window.__WINGO_BROWSER_BRIDGE__)return;window.__WINGO_BROWSER_BRIDGE__=true;const nativeFetch=window.fetch.bind(window);const SB='owouneyvnmcffppiphlu.supabase.co';window.fetch=async function(input,init){const method=String(init&&init.method||'GET').toUpperCase();const raw=typeof input==='string'?input:(input&&input.url)||String(input||'');let u;try{u=new URL(raw,location.href)}catch(e){return nativeFetch(input,init)}if(method==='GET'&&u.hostname===SB&&u.pathname.indexOf('/rest/v1/')===0){const table=u.pathname.split('/').pop();if(table==='wingo_results'||table==='wingo_three_engine_ledger'||table==='wingo_predictions'){const r=await nativeFetch('/api/wingo/live?bridge_ts='+Date.now(),{cache:'no-store'});if(!r.ok)return r;const d=await r.json();let data=table==='wingo_results'?d.rows:(table==='wingo_three_engine_ledger'?d.ledger:d.predictions);data=Array.isArray(data)?data:[];const limit=Number(u.searchParams.get('limit'));if(Number.isFinite(limit)&&limit>0)data=data.slice(0,limit);return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}})}}return nativeFetch(input,init)}})();</script>`;
  fs.readFileSync = function(file, options) {
    const out = nativeReadFileSync.apply(this, arguments);
    try {
      if (typeof out === 'string' && path.basename(String(file)) === 'index.html' && !out.includes('__WINGO_BROWSER_BRIDGE__')) {
        return out.replace(/<\\/head>/i, BRIDGE + '</head>');
      }
      if (Buffer.isBuffer(out) && path.basename(String(file)) === 'index.html') {
        const text = out.toString('utf8');
        if (!text.includes('__WINGO_BROWSER_BRIDGE__')) return Buffer.from(text.replace(/<\\/head>/i, BRIDGE + '</head>'));
      }
    } catch (_) {}
    return out;
  };
  globalThis.__WINGO_BROWSER_BRIDGE__ = true;
}
