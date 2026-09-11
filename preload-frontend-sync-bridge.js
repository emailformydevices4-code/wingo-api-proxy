// Frontend bridge: replace the legacy direct-Supabase browser reader before its script executes.
const nativeReadFileSync = require('fs').readFileSync;
const fs = require('fs');
const path = require('path');
if (!globalThis.__WINGO_FRONTEND_SYNC_BRIDGE__) {
  fs.readFileSync = function patchedReadFileSync(file, options) {
    const out = nativeReadFileSync.apply(this, arguments);
    const isIndex = typeof file === 'string' && path.basename(file) === 'index.html' && file.includes(path.join('public', 'index.html'));
    const encoding = typeof options === 'string' ? options : options && options.encoding;
    if (!isIndex || encoding !== 'utf8') return out;
    const re = /async function api\(t,s,p=""\)\{.*?\}\nconst pct=/s;
    if (!re.test(out)) return out;
    const replacement = `async function api(t,s,p=""){
  const r=await fetch('/api/wingo/live?ts='+Date.now(),{cache:'no-store',headers:{Accept:'application/json'}});
  if(!r.ok)throw Error('live HTTP '+r.status);
  const d=await r.json();
  if(String(t)==='wingo_results')return d.rows||[];
  if(String(t)==='wingo_three_engine_ledger')return d.ledger||[];
  if(String(t)==='wingo_predictions')return d.predictions||[];
  return [];
}
const pct=`;
    return out.replace(re, replacement);
  };
  globalThis.__WINGO_FRONTEND_SYNC_BRIDGE__ = true;
}
