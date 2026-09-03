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
  version: 5,
  latestIssue: null,
  lastCollectedIssue: null,
  lastAnalyzedIssue: null,
  lastPredictionIssue: null,
  lastTimingIssue: null,
  updatedAt: null,
  analysis: { version: 5, experts: {}, csprngAudit: null, research: null },
  houseDay: null,
  houseDayStartedAt: null,
  houseDayPeriodCount: 0
};

const iso = () => new Date().toISOString();
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const compareIssue = (a,b) => { try { const x=BigInt(String(a)), y=BigInt(String(b)); return x<y?-1:x>y?1:0; } catch { return String(a).localeCompare(String(b)); } };

// A House Day runs from 05:30 IST to 05:30 IST. The ledger is never deleted
// at reset; only the current-day/session counters roll over.
const HOUSE_TZ = 'Asia/Kolkata';
const HOUSE_RESET_HOUR = 5;
const HOUSE_RESET_MINUTE = 30;
const PERIODS_PER_HOUSE_DAY = 2880;
function houseDayInfo(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: HOUSE_TZ, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).formatToParts(date);
  const get = k => parts.find(p => p.type === k)?.value;
  let y=Number(get('year')), m=Number(get('month')), d=Number(get('day')), h=Number(get('hour')), mi=Number(get('minute'));
  if (h < HOUSE_RESET_HOUR || (h === HOUSE_RESET_HOUR && mi < HOUSE_RESET_MINUTE)) {
    const prev = new Date(Date.UTC(y,m-1,d) - 86400000);
    y=prev.getUTCFullYear(); m=prev.getUTCMonth()+1; d=prev.getUTCDate();
  }
  const id = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  return { id, timezone: HOUSE_TZ, resetLocal: '05:30', periodsPerDay: PERIODS_PER_HOUSE_DAY };
}
function ensureHouseDay(date = new Date()) {
  const info=houseDayInfo(date);
  if(state.houseDay !== info.id){
    state.houseDay=info.id;
    state.houseDayStartedAt=info.id+'T05:30:00+05:30';
    state.houseDayPeriodCount=0;
    // Keep permanent ledger/history and model memory. Only current-day counters reset.
    state.daily={houseDay:info.id,big:0,small:0,total:0,streakSide:null,streakLength:0};
  }
  state.daily=state.daily||{houseDay:info.id,big:0,small:0,total:0,streakSide:null,streakLength:0};
  if(state.daily.houseDay!==info.id){ state.daily={houseDay:info.id,big:0,small:0,total:0,streakSide:null,streakLength:0}; }
  return info;
}
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
        house_day TEXT,
        house_day_started_at TIMESTAMPTZ,
        house_day_period_count INTEGER NOT NULL DEFAULT 0,
        daily_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ
      );
      INSERT INTO wingo_state(id, updated_at) VALUES(1,NOW()) ON CONFLICT(id) DO NOTHING;
      CREATE TABLE IF NOT EXISTS wingo_analysis_state (
        id INTEGER PRIMARY KEY CHECK(id=1),
        version INTEGER NOT NULL DEFAULT 4,
        experts JSONB NOT NULL DEFAULT '{}'::jsonb,
        csprng_audit JSONB,
        research JSONB,
        updated_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS wingo_research_snapshots (
        issue TEXT PRIMARY KEY REFERENCES wingo_results(issue) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL,
        window_count INTEGER NOT NULL,
        snapshot JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wingo_research_created ON wingo_research_snapshots(created_at DESC);
      INSERT INTO wingo_analysis_state(id, updated_at) VALUES(1,NOW()) ON CONFLICT(id) DO NOTHING;
      ALTER TABLE wingo_analysis_state ADD COLUMN IF NOT EXISTS research JSONB;
      ALTER TABLE wingo_state ADD COLUMN IF NOT EXISTS house_day TEXT;
      ALTER TABLE wingo_state ADD COLUMN IF NOT EXISTS house_day_started_at TIMESTAMPTZ;
      ALTER TABLE wingo_state ADD COLUMN IF NOT EXISTS house_day_period_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE wingo_state ADD COLUMN IF NOT EXISTS daily_json JSONB NOT NULL DEFAULT '{}'::jsonb;
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
    state.houseDay = x.house_day || null;
    state.houseDayStartedAt = x.house_day_started_at?.toISOString() || null;
    state.houseDayPeriodCount = Number(x.house_day_period_count || 0);
    state.daily = x.daily_json || null;
  }
  const a = await db.query('SELECT * FROM wingo_analysis_state WHERE id=1');
  if (a.rows[0]) state.analysis = { version: a.rows[0].version, experts: a.rows[0].experts || {}, csprngAudit: a.rows[0].csprng_audit || null, research: a.rows[0].research || null };
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
    await db.query(`UPDATE wingo_state SET latest_issue=$1,last_collected_issue=$2,last_analyzed_issue=$3,last_prediction_issue=$4,last_timing_issue=$5,house_day=$6,house_day_started_at=$7,house_day_period_count=$8,daily_json=$9,updated_at=NOW() WHERE id=1`, [
      state.latestIssue, state.lastCollectedIssue, state.lastAnalyzedIssue, state.lastPredictionIssue, state.lastTimingIssue,
      state.houseDay, state.houseDayStartedAt, Number(state.houseDayPeriodCount||0), JSON.stringify(state.daily||{})
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
  ensureHouseDay();
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
    state.houseDayPeriodCount = Math.min(PERIODS_PER_HOUSE_DAY, Number(state.houseDayPeriodCount||0)+1);
    state.daily.total++;
    state.daily[result.side==='BIG'?'big':'small']++;
    if(state.daily.streakSide===result.side) state.daily.streakLength++; else { state.daily.streakSide=result.side; state.daily.streakLength=1; }
    state.updatedAt = iso();
    saveJson();
    let research = null; try { research = researchSnapshot((state.results || []).slice().sort((a,b)=>compareIssue(a.issue,b.issue))); state.analysis.research = research; saveJson(); } catch (e) { console.error('[RESEARCH]', e.message); }
    return { inserted: true, result, timing: { issue: result.issue, leadMs }, researchReady: Boolean(research?.ready) };
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
    await client.query(`UPDATE wingo_state SET latest_issue=CASE WHEN latest_issue IS NULL OR latest_issue < $1 THEN $1 ELSE latest_issue END,last_collected_issue=$1,last_timing_issue=$1,house_day=$2,house_day_started_at=$3,house_day_period_count=LEAST($4,house_day_period_count+1),daily_json=$5,updated_at=NOW() WHERE id=1`, [result.issue,state.houseDay,state.houseDayStartedAt,PERIODS_PER_HOUSE_DAY,JSON.stringify(state.daily||{})]);
    await client.query('COMMIT');
    state.houseDayPeriodCount = Math.min(PERIODS_PER_HOUSE_DAY, Number(state.houseDayPeriodCount||0)+1);
    state.daily.total++; state.daily[result.side==='BIG'?'big':'small']++;
    if(state.daily.streakSide===result.side) state.daily.streakLength++; else { state.daily.streakSide=result.side; state.daily.streakLength=1; }
    const currentLatest = state.latestIssue;
    if (!currentLatest || compareIssue(result.issue, currentLatest) > 0) state.latestIssue = result.issue;
    state.lastCollectedIssue = result.issue; state.lastTimingIssue = result.issue; state.updatedAt = iso();
    let research = null;
    try { research = await computeAndStoreResearch(); } catch (e) { console.error('[RESEARCH]', e.message); }
    return { inserted: true, result, timing: { issue: result.issue, leadMs }, ledger: { recordHash, previousHash }, researchReady: Boolean(research?.ready) };
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
  if (db) await db.query('UPDATE wingo_analysis_state SET version=$1,experts=$2,csprng_audit=$3,research=$4,updated_at=NOW() WHERE id=1', [state.analysis.version, JSON.stringify(state.analysis.experts || {}), JSON.stringify(state.analysis.csprngAudit || null), JSON.stringify(state.analysis.research || null)]);
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


function binarySequence(rows) { return rows.map(x => x.side === 'BIG' ? 1 : 0); }
function safeMean(a) { return a.length ? a.reduce((s,x)=>s+x,0)/a.length : null; }
function entropyBinary(seq) {
  if (!seq.length) return null;
  const p = seq.reduce((s,x)=>s+x,0)/seq.length;
  if (p<=0 || p>=1) return 0;
  return -(p*Math.log2(p)+(1-p)*Math.log2(1-p));
}
function transitionMatrix(seq) {
  const c = {BB:0,BS:0,SB:0,SS:0};
  for (let i=1;i<seq.length;i++) c[(seq[i-1]?'B':'S')+(seq[i]?'B':'S')]++;
  const out={counts:c};
  for (const k of ['B','S']) {
    const den=k==='B'?c.BB+c.BS:c.SB+c.SS;
    out[k]={toBig:den?(k==='B'?c.BB:c.SB)/den:null,toSmall:den?(k==='B'?c.BS:c.SS)/den:null,n:den};
  }
  return out;
}
function runStats(seq) {
  if (seq.length<2) return {runs:null,longest:null,current:null};
  let runs=1,longest=1,current=1;
  for(let i=1;i<seq.length;i++) { if(seq[i]===seq[i-1]) { current++; longest=Math.max(longest,current); } else { runs++; current=1; } }
  const n1=seq.reduce((s,x)=>s+x,0), n0=seq.length-n1;
  let z=null;
  if(n0&&n1) { const mean=1+(2*n1*n0)/seq.length; const variance=(2*n1*n0*(2*n1*n0-seq.length))/(seq.length**2*(seq.length-1)); z=(runs-mean)/Math.sqrt(Math.max(variance,1e-12)); }
  return {runs,longest,current,z};
}
function lag1Binary(seq) {
  if(seq.length<3) return null;
  const a=seq.slice(0,-1),b=seq.slice(1),ma=safeMean(a),mb=safeMean(b); let num=0,da=0,db=0;
  for(let i=0;i<a.length;i++){const x=a[i]-ma,y=b[i]-mb;num+=x*y;da+=x*x;db+=y*y;}
  return da&&db?num/Math.sqrt(da*db):0;
}
function patternTable(seq, maxLen=4) {
  const out=[];
  for(let len=1;len<=maxLen;len++) {
    const m=new Map();
    for(let i=len;i<seq.length;i++) {
      const key=seq.slice(i-len,i).map(x=>x?'B':'S').join('');
      const v=m.get(key)||{pattern:key,nextBig:0,nextSmall:0};
      seq[i]?v.nextBig++:v.nextSmall++; m.set(key,v);
    }
    for(const v of m.values()) { const n=v.nextBig+v.nextSmall; if(n>=8) out.push({...v,n,bigRate:v.nextBig/n,smallRate:v.nextSmall/n,len}); }
  }
  return out.sort((a,b)=>b.n-a.n).slice(0,80);
}
function modelPrediction(kind, train) {
  if(!train.length) return 0.5;
  if(kind==='baseline') return 0.5;
  if(kind==='recent') { const w=train.slice(-10).map(x=>x.side==='BIG'?1:0); return w.length?safeMean(w):0.5; }
  if(kind==='persistence') return train[train.length-1].side==='BIG' ? 0.6 : 0.4;
  if(kind==='transition') {
    const last=train[train.length-1].side==='BIG'?1:0; let bb=0,bs=0,sb=0,ss=0;
    for(let i=1;i<train.length;i++){const p=train[i-1].side==='BIG',c=train[i].side==='BIG'; if(p&&c)bb++;else if(p&&!c)bs++;else if(!p&&c)sb++;else ss++;}
    const den=last?bb+bs:sb+ss; return den?((last?bb:sb)/den):0.5;
  }
  return 0.5;
}
function brier(y,p){return (p-y)**2;}
function walkForward(rows) {
  const kinds=['baseline','recent','persistence','transition'];
  const scores=Object.fromEntries(kinds.map(k=>[k,{n:0,brierSum:0,accuracy:0}]));
  const start=Math.max(30,Math.floor(rows.length*0.25));
  for(let i=start;i<rows.length;i++) {
    const train=rows.slice(0,i), y=rows[i].side==='BIG'?1:0;
    for(const k of kinds){const p=Math.min(.99,Math.max(.01,modelPrediction(k,train))); const s=scores[k]; s.n++; s.brierSum+=brier(y,p); s.accuracy+=((p>=.5)?1:0)===y?1:0;}
  }
  for(const k of kinds){const s=scores[k];s.brier=s.n?s.brierSum/s.n:null;s.accuracyRate=s.n?s.accuracy/s.n:null;delete s.brierSum;}
  const base=scores.baseline.brier;
  for(const k of kinds) scores[k].brierSkill=(base!=null&&scores[k].brier!=null)?1-(scores[k].brier/base):null;
  return {startIndex:start,scores};
}
function regimeReport(rows) {
  const windows={1:2,3:6,5:10,10:20,15:30,30:60,60:120};
  const out={};
  for(const [minutes,count] of Object.entries(windows)) {
    const r=rows.slice(-count), seq=binarySequence(r), n=seq.length, big=safeMean(seq);
    out[minutes]={minutes:Number(minutes),observations:n,bigRate:big,smallRate:n?1-big:null,entropyBits:entropyBinary(seq),runs:runStats(seq),lag1:lag1Binary(seq),transitions:transitionMatrix(seq)};
  }
  const full=rows.slice(-Math.min(rows.length,1200)), f=safeMean(binarySequence(full));
  const five=out[5];
  out.comparison={baselineBigRate:f,window5mDelta:five&&five.bigRate!=null?five.bigRate-f:null};
  return out;
}
function hypothesisReport(rows) {
  const seq=binarySequence(rows), base=safeMean(seq);
  const pats=patternTable(seq,4);
  const notable=pats.filter(x=>x.n>=12 && Math.abs(x.bigRate-base)>=0.08).slice(0,20).map(x=>({...x,deltaFromBaseline:x.bigRate-base}));
  const b3=pats.find(x=>x.pattern==='BBB'),s3=pats.find(x=>x.pattern==='SSS');
  return {baselineBigRate:base,patternsTested:pats.length,notablePatterns:notable,streak3:{BBB:b3||null,SSS:s3||null},interpretation:notable.length?'Candidate associations require continued walk-forward validation.':'No sufficiently supported strong pattern found in the current sample.'};
}
function researchSnapshot(rows) {
  const sorted=rows.slice().sort((a,b)=>compareIssue(a.issue,b.issue));
  const latest=sorted[sorted.length-1]||null;
  if(!latest) return {ready:false,observations:0};
  const regimes=regimeReport(sorted);
  const hypotheses=hypothesisReport(sorted);
  const wf=sorted.length>=40?walkForward(sorted):{ready:false,reason:'Need at least 40 observations for the initial walk-forward report.'};
  const seq=binarySequence(sorted.slice(-Math.min(120,sorted.length)));
  return {
    ready:true,version:'house-research-v2',latestIssue:latest.issue,observations:sorted.length,primaryTarget:'BIG_SMALL',generatedAt:iso(),
    windows:regimes,hypotheses,walkForward:wf,
    currentState:{side:latest.side,number:latest.number,color:latest.color,parity:latest.parity},
    rules:[
      'Big/Small is the primary target; number, parity and colour are contextual attributes.',
      'Associations are not treated as causal explanations.',
      'Short windows are descriptive and do not establish predictive edge.',
      'Models are evaluated chronologically against a neutral baseline.',
      'Weak or unstable evidence should reduce confidence or trigger abstention.'
    ],
    currentDiagnostics:{last120Runs:runStats(seq),last120Lag1:lag1Binary(seq),last120EntropyBits:entropyBinary(seq)}
  };
}
async function computeAndStoreResearch() {
  const rows=await getResults(Math.min(MAX_HISTORY,1500));
  const snap=researchSnapshot(rows);
  state.analysis.research=snap;
  await saveAnalysis();
  if(db && snap.ready) await db.query('INSERT INTO wingo_research_snapshots(issue,created_at,window_count,snapshot) VALUES($1,NOW(),$2,$3) ON CONFLICT(issue) DO UPDATE SET created_at=EXCLUDED.created_at,window_count=EXCLUDED.window_count,snapshot=EXCLUDED.snapshot',[snap.latestIssue,snap.observations,JSON.stringify(snap)]);
  return snap;
}
async function verifyLedger() {
  if(!db) return {ready:false,storage:storageMode,message:'Ledger verification requires PostgreSQL.'};
  const q=await db.query(`SELECT l.issue,l.ledger_seq,l.previous_hash,l.record_hash,r.number,r.side,r.parity,r.color,r.first_seen_at,r.source,r.raw_sha256 FROM wingo_ledger l JOIN wingo_results r ON r.issue=l.issue ORDER BY l.ledger_seq ASC`);
  let previous=null, checked=0, broken=null;
  for(const x of q.rows){
    const material=JSON.stringify({issue:String(x.issue),number:Number(x.number),side:x.side,parity:x.parity,color:x.color||'',firstSeenAt:x.first_seen_at.toISOString(),source:x.source,rawSha256:x.raw_sha256,previousHash:previous});
    const expected=sha256(material);
    if(x.previous_hash!==previous || x.record_hash!==expected){broken={issue:String(x.issue),ledgerSeq:Number(x.ledger_seq),expectedPreviousHash:previous,storedPreviousHash:x.previous_hash,expectedRecordHash:expected,storedRecordHash:x.record_hash};break;}
    previous=x.record_hash;checked++;
  }
  return {ready:true,valid:!broken,checked,records:q.rows.length,headHash:previous,brokenAt:broken,verifiedAt:iso()};
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
    houseDay: { ...houseDayInfo(), id: state.houseDay, startedAt: state.houseDayStartedAt, periodCount: Number(state.houseDayPeriodCount||0), periodsPerDay: PERIODS_PER_HOUSE_DAY, daily: state.daily||{} },
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
  if (req.method === 'GET' && u.pathname === '/api/health') return json(res,200,{ok:true,service:'wingo-house-ai-v13',time:iso(),storage:storageMode});
  if (req.method === 'GET' && (u.pathname === '/api/status' || u.pathname === '/api/state')) { ensureHouseDay(); return json(res,200,{ok:Boolean(state.latestIssue),...currentState()}); }
  if (req.method === 'GET' && u.pathname === '/api/house-day') { ensureHouseDay(); return json(res,200,{ok:true,houseDay:currentState().houseDay}); }
  if (req.method === 'GET' && u.pathname === '/api/history') return json(res,200,{ok:true,results:await getResults(u.searchParams.get('limit')||100)});
  if (req.method === 'GET' && u.pathname === '/api/timing') { const records=await getTiming(u.searchParams.get('limit')||100); const vals=records.map(x=>x.leadMs).filter(Number.isFinite); return json(res,200,{ok:true,records,stats:{count:vals.length,averageLeadMs:vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:null,minimumLeadMs:vals.length?Math.min(...vals):null,maximumLeadMs:vals.length?Math.max(...vals):null}}); }
  if (req.method === 'GET' && u.pathname === '/api/ledger') return json(res,200,{ok:true,records:await getLedger(u.searchParams.get('limit')||50)});
  if (req.method === 'GET' && u.pathname === '/api/ledger-verify') return json(res,200,await verifyLedger());
  if (req.method === 'GET' && u.pathname === '/api/research') return json(res,200,state.analysis.research || await computeAndStoreResearch());
  if (req.method === 'GET' && u.pathname === '/api/csprng-audit') return json(res,200,await csprngAudit(Math.min(MAX_HISTORY,u.searchParams.get('limit')||1000)));
  if (req.method === 'GET' && u.pathname === '/api/research-snapshot') {
    const results = await getResults(u.searchParams.get('limit')||1000);
    const ledger = await getLedger(u.searchParams.get('ledgerLimit')||20);
    return json(res,200,{ok:true,state:currentState(),results,ledger,csprngAudit:state.analysis.csprngAudit,research:state.analysis.research});
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
  ensureHouseDay();
  if (!(await initDb())) { loadJson(); ensureHouseDay(); console.log(`[STORAGE] JSON fallback at ${STATE_FILE}. Configure DATABASE_URL for durable storage.`); }
  if (SERVER_COLLECTOR_ENABLED) { collectUpstream(); setInterval(collectUpstream,POLL_MS); }
  const server=http.createServer((req,res)=>handle(req,res).catch(e=>{console.error('[REQUEST ERROR]',e);json(res,500,{error:'Internal server error'});}));
  server.listen(PORT,'0.0.0.0',()=>console.log(`WinGo House AI v12 running on port ${PORT}`));
  const stop=async()=>{serverCollectorRunning=false;if(db)await db.end();process.exit(0)}; process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
boot().catch(e=>{console.error('[FATAL]',e);process.exit(1)});
