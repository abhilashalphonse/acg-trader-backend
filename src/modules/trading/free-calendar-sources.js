'use strict';

// Only ShowMyTrades is permitted as a commercial zero-cost calendar input.
// BLS is a primary-source cross-check for selected US releases. XOOMAR is
// deliberately not fetched: its free tier lacks a commercial product licence.
const CURRENCIES = new Set(['USD','EUR','GBP','JPY','AUD','NZD','CAD','CHF','CNY']);
const HOUR = 3600000;
const DAY = 86400000;
const CORE_BLS = Object.freeze([
  { label: 'employment', pattern: /employment situation|non.?farm|\bnfp\b|\bpayrolls\b/i },
  { label: 'cpi', pattern: /consumer price index|\bcpi\b/i },
  { label: 'ppi', pattern: /producer price index|\bppi\b/i },
]);

function normalizeShowMyTrades(payload, nowMs) {
  if (!payload || !Array.isArray(payload.events) || !Number.isFinite(Number(payload.server_time))) {
    throw new Error('ShowMyTrades calendar response missing events or server clock');
  }
  if (Math.abs(Number(payload.server_time) * 1000 - nowMs) > 10 * 60_000) {
    throw new Error('ShowMyTrades server clock is too far from UTC');
  }
  if (payload.events.length >= 500) throw new Error('ShowMyTrades calendar potentially truncated');
  if (payload.count !== undefined && Number(payload.count) !== payload.events.length) {
    throw new Error('ShowMyTrades calendar count disagrees with response');
  }
  const ids = new Set();
  return payload.events.map(raw => {
    const id = String(raw?.id || '').trim();
    const timestamp = Date.parse(raw?.time || '');
    if (!id || ids.has(id) || !Number.isFinite(timestamp) ||
        (raw.ts != null && Math.abs(timestamp - Number(raw.ts) * 1000) > 1000) ||
        !CURRENCIES.has(String(raw.currency || '').toUpperCase()) ||
        String(raw.impact || '').toLowerCase() !== 'high' || !String(raw.title || '').trim()) {
      throw new Error('ShowMyTrades returned an invalid or duplicate high-impact event');
    }
    ids.add(id);
    // Cancellations never silently remove existing restrictions: the snapshot
    // service detects vanished future event IDs and holds the prior snapshot.
    if (String(raw.status || '').toLowerCase() === 'cancelled') return null;
    return {
      id: 'smt:' + id,
      timestamp: new Date(timestamp).toISOString(),
      currency: String(raw.currency).toUpperCase(),
      impact: 'high',
      title: String(raw.title).trim(),
      country: null,
      category: 'macro',
      provider: 'showmytrades',
    };
  }).filter(Boolean);
}

function easternToUtc(year, month, day, hour, minute, second) {
  const nominal = Date.UTC(year, month - 1, day, hour, minute, second);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  let guess = nominal;
  for (let i = 0; i < 3; i++) {
    const values = Object.fromEntries(formatter.formatToParts(new Date(guess)).map(p => [p.type, p.value]));
    const observed = Date.UTC(+values.year, +values.month - 1, +values.day,
      +values.hour % 24, +values.minute, +values.second);
    guess += nominal - observed;
  }
  return new Date(guess).toISOString();
}

function parseIcsDate(value, tzid) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(value || '');
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  if (m[7]) return new Date(Date.UTC(year, month - 1, day, hour, minute, second || 0)).toISOString();
  if (tzid && !/new.?york|eastern|us-east/i.test(tzid)) return null;
  return easternToUtc(year, month, day, hour, minute, second || 0);
}

function parseBlsIcs(text, { fromMs, toMs }) {
  if (typeof text !== 'string' || !text.includes('BEGIN:VCALENDAR') ||
      !text.includes('BEGIN:VEVENT') || text.length > 4_000_000) {
    throw new Error('BLS calendar is invalid or too large');
  }
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const blocks = unfolded.split('BEGIN:VEVENT').slice(1);
  const events = [];
  for (const block of blocks) {
    const item = block.split('END:VEVENT')[0];
    const summary = /^SUMMARY:(.+)$/mi.exec(item)?.[1]?.replace(/\\,/g, ',') || '';
    const match = CORE_BLS.find(c => c.pattern.test(summary));
    if (!match) continue;
    const dt = /^DTSTART(?:;([^:]+))?:(.+)$/mi.exec(item);
    if (!dt) continue;
    const tzid = /TZID=([^;]+)/i.exec(dt[1] || '')?.[1] || '';
    const time = parseIcsDate(dt[2].trim(), tzid);
    if (!time) continue;
    const at = Date.parse(time);
    if (at < fromMs || at >= toMs) continue;
    events.push({
      id: 'bls:' + match.label + ':' + time.slice(0, 10),
      timestamp: time, currency: 'USD', impact: 'high', title: summary.trim(),
      country: 'United States', category: 'macro', provider: 'bls',
    });
  }
  return events;
}

function combineVerifiedCalendar(primary, official) {
  const all = [...primary];
  let confirmed = 0;
  let conflicts = 0;
  for (const item of official) {
    const label = CORE_BLS.find(c => c.pattern.test(item.title))?.label;
    const same = primary.filter(p => {
      const thisLabel = CORE_BLS.find(c => c.pattern.test(p.title))?.label;
      return thisLabel === label && p.currency === 'USD' &&
        Math.abs(Date.parse(p.timestamp) - Date.parse(item.timestamp)) < DAY;
    });
    if (same.some(p => Math.abs(Date.parse(p.timestamp) - Date.parse(item.timestamp)) <= 60_000)) {
      confirmed++;
    } else {
      // Retain both when two sources disagree; never silently lift a
      // previously known high-impact restriction.
      all.push(item);
      if (same.length) conflicts++;
    }
  }
  return { events: all, verification: { officialEvents: official.length, confirmed, conflicts } };
}

module.exports = { normalizeShowMyTrades, parseBlsIcs, parseIcsDate, combineVerifiedCalendar };
