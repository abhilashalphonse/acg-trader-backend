'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeShowMyTrades, parseBlsIcs, parseIcsDate, combineVerifiedCalendar,
} = require('../../src/modules/trading/free-calendar-sources');

const now = Date.parse('2026-11-13T12:00:00Z');
const payload = () => ({
  server_time: now / 1000,
  count: 2,
  events: [
    { id: 'us-ppi-2026', ts: Date.parse('2026-11-13T13:30:00Z') / 1000,
      time: '2026-11-13T13:30:00Z', impact: 'high', currency: 'USD', title: 'US PPI' },
    { id: 'gb-earnings-2026', ts: Date.parse('2026-11-13T09:30:00Z') / 1000,
      time: '2026-11-13T09:30:00Z', impact: 'high', currency: 'GBP', title: 'UK Average Earnings' },
  ],
});
const ics = (time='20261113T083000') => [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:ppi-november',
  'SUMMARY:Producer Price Index for October 2026',
  'DTSTART;TZID=America/New_York:' + time,
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('ShowMyTrades events normalize to UTC IDs and supported high impact currencies', () => {
  const events = normalizeShowMyTrades(payload(), now);
  assert.equal(events.length, 2);
  assert.equal(events[0].id, 'smt:us-ppi-2026');
  assert.equal(events[0].timestamp, '2026-11-13T13:30:00.000Z');
  assert.equal(events[0].currency, 'USD');
  assert.equal(events[0].impact, 'high');
  assert.equal(events[1].currency, 'GBP');
});

test('unexpected response shapes, replayed timestamps, non-high impact and duplicate IDs fail safely', () => {
  assert.throws(() => normalizeShowMyTrades({events: []}, now), /server clock/);
  const old = payload(); old.server_time -= 900; assert.throws(() => normalizeShowMyTrades(old, now), /clock/);
  const inconsistent = payload(); inconsistent.count = 1;
  assert.throws(() => normalizeShowMyTrades(inconsistent, now), /count/);
  const duplicates = payload(); duplicates.events[1].id = duplicates.events[0].id;
  assert.throws(() => normalizeShowMyTrades(duplicates, now), /duplicate/);
  const medium = payload(); medium.events[1].impact = 'medium';
  assert.throws(() => normalizeShowMyTrades(medium, now), /invalid/);
  const unknown = payload(); unknown.events[1].currency = 'XXX';
  assert.throws(() => normalizeShowMyTrades(unknown, now), /invalid/);
});

test('provider cancellation does not become a new tradable event', () => {
  const p = payload(); p.events[0].status = 'cancelled';
  assert.equal(normalizeShowMyTrades(p, now).length, 1);
});

test('BLS ICS can be parsed with Eastern DST correctly in winter and summer', () => {
  assert.equal(parseIcsDate('20261113T083000', 'America/New_York'), '2026-11-13T13:30:00.000Z');
  assert.equal(parseIcsDate('20260713T083000', 'America/New_York'), '2026-07-13T12:30:00.000Z');
  assert.equal(parseIcsDate('20261113T133000Z', ''), '2026-11-13T13:30:00.000Z');
  const events = parseBlsIcs(ics(), {fromMs:now - 3600000,toMs:now + 86400000});
  assert.equal(events.length, 1);
  assert.equal(events[0].timestamp, '2026-11-13T13:30:00.000Z');
  assert.equal(events[0].id, 'bls:ppi:2026-11-13');
});

test('BLS independent verification avoids duplicate blocks for agreeing sources', () => {
  const global = normalizeShowMyTrades(payload(), now);
  const official = parseBlsIcs(ics(), {fromMs:now - 3600000,toMs:now + 86400000});
  const result = combineVerifiedCalendar(global, official);
  assert.equal(result.events.length, 2);
  assert.equal(result.verification.confirmed, 1);
  assert.equal(result.verification.conflicts, 0);
});

test('conflicting government schedule is retained rather than silently dropped', () => {
  const global = normalizeShowMyTrades(payload(), now);
  const official = parseBlsIcs(ics('20261113T093000'), {fromMs:now - 3600000,toMs:now + 86400000});
  const result = combineVerifiedCalendar(global, official);
  assert.equal(result.events.length, 3);
  assert.equal(result.verification.confirmed, 0);
  assert.equal(result.verification.conflicts, 1);
  assert.equal(result.events.at(-1).timestamp, '2026-11-13T14:30:00.000Z');
});

test('invalid official calendar input is never incorrectly labelled verified', () => {
  assert.throws(() => parseBlsIcs('not a calendar', {fromMs:0,toMs:now}), /invalid/);
});
