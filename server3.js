const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const UPSTREAM_URL = process.env.UPSTREAM_URL || 'https://draw.ar-lottery01.com/WinGo/WinGo_30S/GetHistoryIssuePage.json';
const SERVER_COLLECTOR_ENABLED = String(process.env.SERVER_COLLECTOR_ENABLED || 'false').toLowerCase() === 'true';
const POLL_MS = Math.max(1000, Number(process.env.POLL_MS || 1000));
const REQUEST_TIMEOUT_MS = Math.max(1000, Number(process.env.REQUEST_TIMEOUT_MS || 5000));
const MAX_HISTORY = Math.max(100, Number(process.env.MAX_HISTORY || 10000));
const TIMING_LIMIT = Math.max(100, Number(process.env.TIMING_LIMIT || 5000));
const PERIOD_SEC = Math.max(1, Number(process.env.PERIOD_SEC || 30));
const DATABASE_URL = process.env.DATABASE_URL || '';
const INGEST_SECRET = process.env.INGEST_SECRET || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');

let db = null;
let storageMode = 'json';
let latestPayload = null;
let latestFetchedAt = 0;
let upstreamError = null;
let fetching = false;
let serverCollectorRunning = SERVER_COLLECTOR_ENABLED;
let state = {
  version: 3,
  latestIssue: null,
  lastCollectedIssue: null,
  lastAnalyzedIssue: null,
  lastPredictionIssue: null,
  lastTimingIssue: null,
  updatedAt: null,
  analysis: { version: 2, experts: {}, csprngAudit: null }
};

const iso = () => new Date().toISOString();
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const compareIssue = (a,b) => { try { const x=BigInt(String(a)), y=BigInt(String(b)); return x<y?-1:x>y?1:0; } catch { return String(a).localeCompare(String(b)); } };
const canonical = value => JSON.stringify(value, Object.keys(value || {}).sort());

function loadJson() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(STATE_FILE)) return;
    const x = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (x && typeof x === 'object') state = { ...state, ...x, analysis: { ...state.analysis, ...(x.analysis || {}) } };
  } catch (e) { console.error('[STORAGE]', e.message); }
}
function saveJson() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

async function initDb() {
  if (!DATABASE_URL) return false;
  try {
    const { Pool } = require('pg');
    db = new Pool({
      connectionString: DATABASE_URL,
      max: Number(process.env.DB_POOL_MAX || 5),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false }
    });
    await db.query(`
      CREATE TABLE IF NOT EXISTS wingo_results (
        issue TEXT PRIMARY KEY,
        number INTEGER NOT NULL CHECK(number BETWEEN 0 AND 9),
        side TEXT NOT NULL CHECK(side IN ('BIG','SMALL')),
        parity TEXT NOT NULL CHECK(parity IN ('EVEN','ODD')),
        color TEXT NOT NULL DEFAULT '',
        first_seen_at TIMESTAMPTZ NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL,
        source TEXT NOT NULL DEFAULT 'authorized-client',
        raw JSONB,
        raw_sha256 TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wingo_results_seen ON wingo_results(first_seen_at DESC);
      CREATE TABLE IF NOT EXISTS wingo_timing (
        issue TEXT PRIMARY KEY REFERENCES wingo_results(issue) ON DELETE CASCADE,
        first_seen_at TIMESTAMPTZ NOT NULL,
        lead_ms INTEGER,
        period_sec INTEGER NOT NULL,
        measured_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wingo_ledger (
        issue TEXT PRIMARY KEY REFERENCES wingo_results(issue) ON DELETE CASCADE,
        ledger_seq BIGSERIAL UNIQUE NOT NULL,
        previous_hash TEXT,
        record_hash TEXT UNIQUE NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wingo_ledger_seq ON wingo_ledger(ledger_seq);
      CREATE TABLE IF NOT EXISTS wingo_state (
        id INTEGER PRIMARY KEY CHECK(id=1),
        latest_issue TEXT,
        last_collected_issue TEXT,
        last_analyzed_issue TEXT,
        last_prediction_issue TEXT,
        last_timing_issue TEXT,
        updated_at TIMESTAMPTZ
      );
      INSERT INTO wingo_state(id, updated_at) VALUES(1,NOW()) ON CONFLICT(id) DO NOTHING;
      CREATE TABLE IF NOT EXISTS wingo_analysis_state (
        id INTEGER PRIMARY KEY CHECK(id=1),
        version INTEGER NOT NULL DEFAULT 2,
        experts JSONB NOT NULL DEFAULT '{}'::jsonb,
        csprng_audit JSONB,
        updated_at TIMESTAMPTZ
      );
      INSERT INTO wingo_analysis_state(id, updated_at) VALUES(1,NOW()) ON CONFLICT(id) DO NOTHING;
    `);
    storageMode = 'postgres';
    await hydrate();
    console.log('[STORAGE] PostgreSQL enabled');
    return true;
  } catch (e) {
    console.error('[STORAGE] PostgreSQL initialization failed:', e.message);
    db = null;
    return false;
  }
}

async function hydrate() {
  const s = await db.query('SELECT * FROM wingo_state WHERE id=1');
  if (s.rows[0]) {
    const x = s.rows[0];
    state.latestIssue = x.latest_issue;
    state.lastCollectedIssue = x.last_collected_issue;
    state.lastAnalyzedIssue = x.last_analyzed_issue;
    state.lastPredictionIssue = x.last_prediction_issue;
    state.lastTimingIssue = x.last_timing_issue;
    state.updatedAt = x.updated_at?.toISOString() || null;
  }
  const a = await db.query('SELECT * FROM wingo_analysis_state WHERE id=1');
  if (a.rows[0]) state.analysis = { version: a.rows[0].version, experts: a.rows[0].experts || {}, csprngAudit: a.rows[0].csprng_audit || null };
}

function normalize(raw, observedAt = Date.now(), source = 'authorized-client') {
  const n = Number(raw?.number);
  const issue = String(raw?.issueNumber ?? raw?.issue ?? '').trim();
  if (!issue || !Number.isInteger(n) || n < 0 || n > 9) return null;
  const color = String(raw?.color ?? '');
  return {
    issue, number: n,
    side: n >= 5 ? 'BIG' : 'SMALL',
    parity: n % 2 === 0 ? 'EVEN' : 'ODD',
    color,
    firstSeenAt: new Date(observedAt).toISOString(),
    fetchedAt: new Date(observedAt).toISOString(),
    source,
    raw: raw ?? null,
    rawSha256: sha256(JSON.stringify(raw ?? null))
  };
}

function cycleLeadMs(ms) {
  const p = PERIOD_SEC * 1000;
  const r = ((ms % p) + p) % p;
  return (p - r) % p;
}

async function setState(patch) {
  state = { ...state, ...patch, updatedAt: iso() };
  if (db) {
    await db.query(`UPDATE wingo_state SET latest_issue=$1,last_collected_issue=$2,last_analyzed_issue=$3,last_prediction_issue=$4,last_timing_issue=$5,updated_at=NOW() WHERE id=1`, [
      state.latestIssue, state.lastCollectedIssue, state.lastAnalyzedIssue, state.lastPredictionIssue, state.lastTimingIssue
    ]);
  } else saveJson();
}

async function getResult(issue) {
  if (db) {
    const q = await db.query('SELECT * FROM wingo_results WHERE issue=$1', [String(issue)]);
    if (!q.rows[0]) return null;
    const x = q.rows[0];
    return { issue: String(x.issue), number: Number(x.number), side: x.side, parity: x.parity, color: x.color || '', firstSeenAt: x.first_seen_at.toISOString(), fetchedAt: x.fetched_at.toISOString(), source: x.source, raw: x.raw, rawSha256: x.raw_sha256 };
  }
  return null;
}

async function persistResult(result, timingOverride = null) {
  if (!db) {
    loadJson();
    state.results = Array.isArray(state.results) ? state.results : [];
    state.timing = Array.isArray(state.timing) ? state.timing : [];
    if (state.results.some(x => x.issue === result.issue)) return { inserted: false, result };
    state.results.push(result);
    const leadMs = Number.isFinite(timingOverride) ? Math.round(timingOverride) : cycleLeadMs(Date.parse(result.firstSeenAt));
    state.timing.unshift({ issue: result.issue, firstSeenAt: result.firstSeenAt, leadMs, periodSec: PERIOD_SEC, measuredAt: iso() });
    state.results = state.results.slice(-MAX_HISTORY);
    state.timing = state.timing.slice(0, TIMING_LIMIT);
    if (!state.latestIssue || compareIssue(result.issue, state.latestIssue) > 0) state.latestIssue = result.issue;
    state.lastCollectedIssue = result.issue;
    state.lastTimingIssue = result.issue;
    state.updatedAt = iso();
    saveJson();
    return { inserted: true, result, timing: { issue: result.issue, leadMs } };
  }

  // Serialize ledger appends inside the transaction so concurrent browser
  // observations cannot create two different "next" hashes.
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(87120331)');
    const existing = await client.query('SELECT issue FROM wingo_results WHERE issue=$1', [result.issue]);
    if (existing.rowCount) { await client.query('COMMIT'); return { inserted: false, result: await getResult(result.issue) }; }
    await client.query(`INSERT INTO wingo_results(issue,number,side,parity,color,first_seen_at,fetched_at,source,raw,raw_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
      result.issue, result.number, result.side, result.parity, result.color, result.firstSeenAt, result.fetchedAt, result.source, JSON.stringify(result.raw), result.rawSha256
    ]);
    const prev = await client.query('SELECT record_hash FROM wingo_ledger ORDER BY ledger_seq DESC LIMIT 1');
    const previousHash = prev.rows[0]?.record_hash || null;
    const ledgerMaterial = JSON.stringify({ issue: result.issue, number: result.number, side: result.side, parity: result.parity, color: result.color, firstSeenAt: result.firstSeenAt, source: result.source, rawSha256: result.rawSha256, previousHash });
    const recordHash = sha256(ledgerMaterial);
    await client.query(`INSERT INTO wingo_ledger(issue,previous_hash,record_hash,created_at) VALUES($1,$2,$3,NOW())`, [result.issue, previousHash, recordHash]);
    const leadMs = Number.isFinite(timingOverride) ? Math.round(timingOverride) : cycleLeadMs(Date.parse(result.firstSeenAt));
    await client.query(`INSERT INTO wingo_timing(issue,first_seen_at,lead_ms,period_sec,measured_at) VALUES($1,$2,$3,$4,NOW()) ON CONFLICT(issue) DO NOTHING`, [result.issue, result.firstSeenAt, leadMs, PERIOD_SEC]);
    await client.query(`UPDATE wingo_state SET latest_issue=CASE WHEN latest_issue IS NULL OR latest_issue < $1 THEN $1 ELSE latest_issue END,last_collected_issue=$1,last_timing_issue=$1,updated_at=NOW() WHERE id=1`, [result.issue]);
    await client.query('COMMIT');
    const currentLatest = state.latestIssue;
    if (!currentLatest || compareIssue(result.issue, currentLatest) > 0) state.latestIssue = result.issue;
    state.lastCollectedIssue = result.issue; state.lastTimingIssue = result.issue; state.updatedAt = iso();
    return { inserted: true, result, timing: { issue: result.issue, leadMs }, ledger: { recordHash, previousHash } };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

async function getResults(limit = 100) {
  limit = Math.min(MAX_HISTORY, Math.max(1, Number(limit) || 100));
  if (db) {
    const q = await db.query(`SELECT r.*, l.ledger_seq, l.previous_hash, l.record_hash FROM wingo_results r LEFT JOIN wingo_ledger l ON l.issue=r.issue ORDER BY r.issue DESC LIMIT $1`, [limit]);
    return q.rows.reverse().map(x => ({ issue: String(x.issue), number: Number(x.number), side: x.side, parity: x.parity, color: x.color || '', firstSeenAt: x.first_seen_at.toISOString(), fetchedAt: x.fetched_at.toISOString(), source: x.source, raw: x.raw, rawSha256: x.raw_sha256, ledgerSeq: x.ledger_seq ? Number(x.ledger_seq) : null, previousHash: x.previous_hash, recordHash: x.record_hash }));
  }
  loadJson();
  return (state.results || []).slice(-limit);
}

async function getTiming(limit = 100) {
  limit = Math.min(TIMING_LIMIT, Math.max(1, Number(limit) || 100));
  if (db) {
    const q = await db.query('SELECT issue,first_seen_at,lead_ms,period_sec,measured_at FROM wingo_timing ORDER BY measured_at DESC LIMIT $1', [limit]);
    return q.rows.map(x => ({ issue: String(x.issue), firstSeenAt: x.first_seen_at.toISOString(), leadMs: x.lead_ms == null ? null : Number(x.lead_ms), periodSec: Number(x.period_sec), measuredAt: x.measured_at.toISOString() }));
  }
  loadJson(); return (state.timing || []).slice(0, limit);
}

async function getLedger(limit = 50) {
  limit = Math.min(MAX_HISTORY, Math.max(1, Number(limit) || 50));
  if (!db) return [];
  const q = await db.query(`SELECT issue,ledger_seq,previous_hash,record_hash,created_at FROM wingo_ledger ORDER BY ledger_seq DESC LIMIT $1`, [limit]);
  return q.rows.map(x => ({ issue: String(x.issue), ledgerSeq: Number(x.ledger_seq), previousHash: x.previous_hash, recordHash: x.record_hash, createdAt: x.created_at.toISOString() }));
}

async function saveAnalysis() {
  if (db) await db.query('UPDATE wingo_analysis_state SET version=$1,experts=$2,csprng_audit=$3,updated_at=NOW() WHERE id=1', [state.analysis.version, JSON.stringify(state.analysis.experts || {}), JSON.stringify(state.analysis.csprngAudit || null)]);
  else saveJson();
}

function cryptoReferenceDigits(n) {
  const out = []; const b = Buffer.alloc(65536);
  while (out.length < n) {
    crypto.randomFillSync(b);
    for (let i = 0; i < b.length && out.length < n; i++) {
      // Rejection sampling avoids modulo bias for decimal digits.
      if (b[i] < 250) out.push(b[i] % 10);
    }
  }
  return out;
}
function distribution(seq) { const c = Array(10).fill(0); for (const x of seq) if (Number.isInteger(x) && x >= 0 && x <= 9) c[x]++; return c.map(v => v / Math.max(1, seq.length)); }
function chiSquareUniform(seq) { if (!seq.length) return null; const expected = seq.length / 10; const c = Array(10).fill(0); for (const x of seq) if (x >= 0 && x <= 9) c[x]++; return c.reduce((s, o) => s + ((o - expected) ** 2) / expected, 0); }
function binaryRuns(seq) {
  const b = seq.map(x => x >= 5 ? 1 : 0); if (b.length < 2) return null;
  let runs = 1; for (let i = 1; i < b.length; i++) if (b[i] !== b[i - 1]) runs++;
  const n1 = b.reduce((s, x) => s + x, 0), n0 = b.length - n1;
  if (!n0 || !n1) return null;
  const mean = 1 + (2 * n1 * n0) / b.length;
  const variance = (2 * n1 * n0 * (2 * n1 * n0 - b.length)) / (b.length ** 2 * (b.length - 1));
  return { runs, z: (runs - mean) / Math.sqrt(Math.max(variance, 1e-12)) };
}
function lag1(seq) { if (seq.length < 3) return null; const a = seq.slice(0, -1), b = seq.slice(1); const ma = a.reduce((s,x)=>s+x,0)/a.length, mb=b.reduce((s,x)=>s+x,0)/b.length; let num=0, da=0, dbb=0; for(let i=0;i<a.length;i++){const x=a[i]-ma,y=b[i]-mb;num+=x*y;da+=x*x;dbb+=y*y;} return da&&dbb ? num/Math.sqrt(da*dbb) : 0; }

async function csprngAudit(limit = 1000) {
  const rows = await getResults(limit);
  const observed = rows.map(x => x.number).filter(Number.isInteger);
  if (!observed.length) return { ready: false, observations: 0, message: 'No observed results available.' };
  const reference = cryptoReferenceDigits(Math.max(2000, observed.length));
  const out = {
    ready: true,
    observations: observed.length,
    referenceObservations: reference.length,
    observedDistribution: distribution(observed),
    referenceDistribution: distribution(reference),
    observedChiSquare: chiSquareUniform(observed),
    referenceChiSquare: chiSquareUniform(reference),
    observedRunsZ: binaryRuns(observed)?.z ?? null,
    referenceRunsZ: binaryRuns(reference)?.z ?? null,
    observedLag1: lag1(observed),
    referenceLag1: lag1(reference),
    updatedAt: iso(),
    protocol: 'house-csprng-reference-v1',
    interpretation: 'Reference/audit baseline only. It does not reconstruct or predict a hidden upstream generator.'
  };
  state.analysis.csprngAudit = out;
  await saveAnalysis();
  return out;
}

async function collectUpstream() {
  if (!serverCollectorRunning || fetching) return;
  fetching = true;
  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(`${UPSTREAM_URL}${UPSTREAM_URL.includes('?') ? '&' : '?'}ts=${Date.now()}`, { signal: ctl.signal, headers: { accept: 'application/json, text/plain, */*' }, cache: 'no-store' });
    if (!r.ok) throw new Error(`Upstream HTTP ${r.status}`);
    const payload = await r.json(); latestPayload = payload; latestFetchedAt = Date.now(); upstreamError = null;
    const list = Array.isArray(payload?.data?.list) ? payload.data.list : [];
    for (const raw of list) { const x = normalize(raw, latestFetchedAt, 'server-authorized-source'); if (x) await persistResult(x); }
  } catch (e) { upstreamError = e.name === 'AbortError' ? `Request timeout after ${REQUEST_TIMEOUT_MS}ms` : e.message; console.error('[UPSTREAM ERROR]', upstreamError); }
  finally { clearTimeout(timeout); fetching = false; }
}

function currentState() {
  return {
    version: state.version,
    storage: storageMode,
    latestIssue: state.latestIssue,
    lastCollectedIssue: state.lastCollectedIssue,
    lastAnalyzedIssue: state.lastAnalyzedIssue,
    lastPredictionIssue: state.lastPredictionIssue,
    lastTimingIssue: state.lastTimingIssue,
    updatedAt: state.updatedAt,
    collector: { enabled: serverCollectorRunning, running: serverCollectorRunning, fetching, pollMs: POLL_MS, upstream: UPSTREAM_URL, latestFetchedAt: latestFetchedAt ? new Date(latestFetchedAt).toISOString() : null, ageMs: latestFetchedAt ? Date.now() - latestFetchedAt : null, upstreamError },
    analysis: state.analysis
  };
}

function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store, no-cache, must-revalidate', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)); }
function authorized(req) { if (!INGEST_SECRET) return true; const a = Buffer.from(String(req.headers['x-ingest-secret'] || '')); const b = Buffer.from(INGEST_SECRET); return a.length === b.length && crypto.timingSafeEqual(a, b); }
async function readBody(req) { const chunks=[]; let size=0; for await (const chunk of req) { size += chunk.length; if(size>2*1024*1024) throw new Error('Request body too large'); chunks.push(chunk); } try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return null;} }

async function handle(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin':'*', 'access-control-allow-methods':'GET,POST,OPTIONS', 'access-control-allow-headers':'content-type,x-ingest-secret' }); return res.end(); }
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) return fs.readFile(INDEX_FILE, (e,d)=>{ if(e){res.writeHead(404);return res.end('Not found')} res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(d); });
  if (req.method === 'GET' && u.pathname === '/api/health') return json(res,200,{ok:true,service:'wingo-house-ai-v11',time:iso(),storage:storageMode});
  if (req.method === 'GET' && (u.pathname === '/api/status' || u.pathname === '/api/state')) return json(res,200,{ok:Boolean(state.latestIssue),...currentState()});
  if (req.method === 'GET' && u.pathname === '/api/history') return json(res,200,{ok:true,results:await getResults(u.searchParams.get('limit')||100)});
  if (req.method === 'GET' && u.pathname === '/api/timing') { const records=await getTiming(u.searchParams.get('limit')||100); const vals=records.map(x=>x.leadMs).filter(Number.isFinite); return json(res,200,{ok:true,records,stats:{count:vals.length,averageLeadMs:vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:null,minimumLeadMs:vals.length?Math.min(...vals):null,maximumLeadMs:vals.length?Math.max(...vals):null}}); }
  if (req.method === 'GET' && u.pathname === '/api/ledger') return json(res,200,{ok:true,records:await getLedger(u.searchParams.get('limit')||50)});
  if (req.method === 'GET' && u.pathname === '/api/csprng-audit') return json(res,200,await csprngAudit(Math.min(MAX_HISTORY,u.searchParams.get('limit')||1000)));
  if (req.method === 'GET' && u.pathname === '/api/research-snapshot') {
    const results = await getResults(u.searchParams.get('limit')||1000);
    const ledger = await getLedger(u.searchParams.get('ledgerLimit')||20);
    return json(res,200,{ok:true,state:currentState(),results,ledger,csprngAudit:state.analysis.csprngAudit});
  }
  if (req.method === 'GET' && u.pathname === '/api/wingo') {
    if (latestPayload) return json(res,200,latestPayload);
    const rows=await getResults(100); if(!rows.length)return json(res,503,{error:'Feed not ready'});
    return json(res,200,{data:{list:rows.slice().reverse().map(x=>({issueNumber:x.issue,number:x.number,color:x.color}))},meta:{source:'persistent-ledger',latestIssue:state.latestIssue}});
  }
  if (req.method === 'POST' && u.pathname === '/api/ingest') {
    if(!authorized(req))return json(res,401,{error:'Unauthorized'});
    const body=await readBody(req); const list=Array.isArray(body?.data?.list)?body.data.list:Array.isArray(body?.list)?body.list:[]; const observedAt=Number(body?.observedAt)||Date.now(); const timingLead=Number.isFinite(Number(body?.leadMs))?Number(body.leadMs):null;
    if(!list.length)return json(res,400,{error:'No result list supplied'});
    const inserted=[]; for(const raw of list){const x=normalize(raw,observedAt,'authorized-client');if(!x)continue;const r=await persistResult(x, raw?.issueNumber===list[0]?.issueNumber ? timingLead : null);if(r.inserted)inserted.push({issue:x.issue,recordHash:r.ledger?.recordHash||null});}
    return json(res,200,{ok:true,inserted,insertedCount:inserted.length,latestIssue:state.latestIssue});
  }
  if (req.method === 'POST' && (u.pathname === '/api/mark-analyzed' || u.pathname === '/api/mark-prediction')) {
    if(!authorized(req))return json(res,401,{error:'Unauthorized'}); const body=await readBody(req); const issue=String(body?.issue||'').trim(); if(!issue)return json(res,400,{error:'issue is required'}); if(!(await getResult(issue)))return json(res,404,{error:'Unknown issue'});
    if(u.pathname==='/api/mark-analyzed')state.lastAnalyzedIssue=issue;else state.lastPredictionIssue=issue; await setState({}); return json(res,200,{ok:true,state:currentState()});
  }
  return json(res,404,{error:'Not found'});
}

async function boot() {
  if (!(await initDb())) { loadJson(); console.log(`[STORAGE] JSON fallback at ${STATE_FILE}. Configure DATABASE_URL for durable storage.`); }
  if (SERVER_COLLECTOR_ENABLED) { collectUpstream(); setInterval(collectUpstream,POLL_MS); }
  const server=http.createServer((req,res)=>handle(req,res).catch(e=>{console.error('[REQUEST ERROR]',e);json(res,500,{error:'Internal server error'});}));
  server.listen(PORT,'0.0.0.0',()=>console.log(`WinGo House AI v11 running on port ${PORT}`));
  const stop=async()=>{serverCollectorRunning=false;if(db)await db.end();process.exit(0)}; process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
boot().catch(e=>{console.error('[FATAL]',e);process.exit(1)});
