// Server preload: short cache for authoritative upstream/Supabase GET reads.
// This file intentionally contains only valid Node.js and does not touch browser code.
const nativeFetch = globalThis.fetch;
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
