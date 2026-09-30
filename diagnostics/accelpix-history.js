'use strict';

require('dotenv').config();

const API_KEY = process.env.ACCELPIX_API_KEY;
const HOST = (process.env.ACCELPIX_HOST || 'apidata.accelpix.in')
  .replace(/^https?:\/\//i, '')
  .replace(/\/$/, '');

if (!API_KEY) {
  console.error('Missing ACCELPIX_API_KEY.');
  process.exit(1);
}

const SYMBOLS = (process.env.ACCELPIX_DIAGNOSTIC_SYMBOLS || 'RELIANCE,RELIANCE-BSE')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function ymd(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function daysAgo(days) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

function endpoint(parts) {
  const encoded = parts.map((part) => encodeURIComponent(part)).join('/');
  const url = new URL(`https://${HOST}/api/fda/rest/${encoded}`);
  url.searchParams.set('api_token', API_KEY);
  return url;
}

async function getJson(url) {
  const started = Date.now();
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'acg-trader-backend/accelpix-history-diagnostic',
    },
    signal: AbortSignal.timeout(30000),
  });
  const raw = await response.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    // handled below
  }
  return {
    status: response.status,
    ok: response.ok,
    latencyMs: Date.now() - started,
    data,
    raw: data === null ? raw.slice(0, 1000) : null,
  };
}

function summarize(label, result) {
  console.log(`\n--- ${label} ---`);
  console.log(`HTTP: ${result.status}`);
  console.log(`Latency: ${result.latencyMs}ms`);

  if (!result.ok) {
    console.log('FAIL:', result.raw || JSON.stringify(result.data).slice(0, 1000));
    return false;
  }

  if (!Array.isArray(result.data)) {
    console.log('Unexpected response shape:', JSON.stringify(result.data).slice(0, 1000));
    return false;
  }

  const rows = result.data;
  console.log(`Records: ${rows.length}`);

  if (rows.length) {
    const first = rows[0];
    const last = rows[rows.length - 1];
    console.log('First:', {
      tkr: first.tkr,
      td: first.td,
      op: first.op,
      hp: first.hp,
      lp: first.lp,
      cp: first.cp,
      vol: first.vol,
      eod: first.eod,
    });
    console.log('Last:', {
      tkr: last.tkr,
      td: last.td,
      op: last.op,
      hp: last.hp,
      lp: last.lp,
      cp: last.cp,
      vol: last.vol,
      eod: last.eod,
    });
  }

  return true;
}

async function main() {
  const end = ymd(daysAgo(0));
  const intraStart = ymd(daysAgo(35));
  const eodStart = ymd(daysAgo(760));

  console.log('============================================================');
  console.log(' ACG Trader - Accelpix Quote + Historical Diagnostic');
  console.log('============================================================');
  console.log(`Host: ${HOST}`);
  console.log(`Symbols: ${SYMBOLS.join(', ')}`);
  console.log(`1m requested range: ${intraStart} -> ${end}`);
  console.log(`EOD requested range: ${eodStart} -> ${end}`);
  console.log('API key: configured (value hidden)');
  console.log('============================================================');

  let failures = 0;

  const quoteUrl = new URL(`https://${HOST}/api/fda/rest/quote`);
  quoteUrl.searchParams.set('api_token', API_KEY);
  const quoteResponse = await fetch(quoteUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'acg-trader-backend/accelpix-history-diagnostic',
    },
    body: JSON.stringify(SYMBOLS),
    signal: AbortSignal.timeout(15000),
  });
  const quoteRaw = await quoteResponse.text();
  let quotes = null;
  try { quotes = JSON.parse(quoteRaw); } catch { /* handled below */ }
  console.log('\n--- Quotes ---');
  console.log(`HTTP: ${quoteResponse.status}`);
  if (quoteResponse.ok && Array.isArray(quotes)) {
    console.table(quotes.map((q) => ({
      tkr: q.tkr,
      sid: q.sid,
      pr: q.pr,
      bp: q.bp,
      ap: q.ap,
      vol: q.vol,
      op: q.op,
      hp: q.hp,
      lp: q.lp,
      cp: q.cp,
      tm: q.tm,
    })));
  } else {
    failures += 1;
    console.log('FAIL:', quoteRaw.slice(0, 1000));
  }

  for (const symbol of SYMBOLS) {
    const intra = await getJson(endpoint([symbol, intraStart, end, '1']));
    if (!summarize(`${symbol} 1-minute`, intra)) failures += 1;

    const eod = await getJson(endpoint([symbol, eodStart, end]));
    if (!summarize(`${symbol} EOD`, eod)) failures += 1;
  }

  console.log('\n============================================================');
  if (failures === 0) {
    console.log('PASS: Accelpix historical REST endpoints returned valid arrays.');
  } else {
    console.log(`CHECK: ${failures} historical request(s) failed or returned an unexpected shape.`);
    process.exitCode = 1;
  }
  console.log('============================================================');
}

main().catch((error) => {
  console.error('Accelpix historical diagnostic failed:', error?.message || error);
  process.exit(1);
});
