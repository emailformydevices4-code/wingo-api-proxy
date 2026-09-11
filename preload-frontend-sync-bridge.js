// Frontend bridge: the legacy page contains its own direct Supabase sync loop.
// Keep that UI loop, but route its data reads through the same server-authoritative
// /api/wingo/live endpoint used by LIVE_PATCH so two clients cannot fight over the DOM.
const nativeReadFileSync = require('fs').readFileSync;
const fs = require('fs');
const path = require('path');
if (!globalThis.__WINGO_FRONTEND_SYNC_BRIDGE__) {
  const marker = '</body>';
  fs.readFileSync = function patchedReadFileSync(file, options) {
    const out = nativeReadFileSync.apply(this, arguments);
    const isIndex = typeof file === 'string' && path.basename(file) === 'index.html' && file.includes(path.join('public', 'index.html'));
    const encoding = typeof options === 'string' ? options : options && options.encoding;
    if (!isIndex || encoding !== 'utf8' || !out.includes(marker)) return out;
    const bridge = `<script>(function(){'use strict';window.api=async function(table){const r=await fetch('/api/wingo/live?ts='+Date.now(),{cache:'no-store'});if(!r.ok)throw Error('live HTTP '+r.status);const d=await r.json();if(table==='wingo_results')return d.rows||[];if(table==='wingo_three_engine_ledger')return d.ledger||[];if(table==='wingo_predictions')return d.predictions||[];return[]};})();</script>`;
    return out.replace(marker, bridge + marker);
  };
  globalThis.__WINGO_FRONTEND_SYNC_BRIDGE__ = true;
}
