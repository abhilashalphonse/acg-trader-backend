'use strict';

const { AppError } = require('../../shared/errors/app-error');

const WEEKDAY = Object.freeze({ SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 });

function isInstrumentSessionOpen(instrument, nowMs = Date.now()) {
  if (!instrument) return false;
  if (instrument.status && instrument.status !== 'ACTIVE') return false;

  const timezone = String(instrument.timezone || 'UTC');
  const local = zonedParts(nowMs, timezone);
  const dateKey = `${local.year}-${pad(local.month)}-${pad(local.day)}`;
  const holidays = (instrument.tradingHolidays || []).map(String);
  if (holidays.includes(dateKey)) return false;

  const sessions = Array.isArray(instrument.tradingSessions) ? instrument.tradingSessions : [];
  if (!sessions.length) return true;

  const minuteOfDay = local.hour * 60 + local.minute;
  const currentDay = local.weekday;
  const previousDay = (currentDay + 6) % 7;

  for (const session of sessions) {
    const days = Array.isArray(session.days) ? session.days.map(Number) : [];
    const open = parseClock(session.open);
    const close = parseClock(session.close);
    if (open == null || close == null) continue;

    if (open <= close) {
      if (days.includes(currentDay) && minuteOfDay >= open && minuteOfDay < close) return true;
      continue;
    }

    if (days.includes(currentDay) && minuteOfDay >= open) return true;
    if (days.includes(previousDay) && minuteOfDay < close) return true;
  }
  return false;
}

function assertInstrumentSessionOpen(instrument, nowMs = Date.now()) {
  if (isInstrumentSessionOpen(instrument, nowMs)) return;
  throw new AppError('Instrument market session is closed', {
    statusCode: 409,
    code: 'MARKET_SESSION_CLOSED',
    details: {
      symbol: instrument?.symbol || null,
      timezone: instrument?.timezone || 'UTC',
      timestamp: new Date(nowMs).toISOString(),
    },
  });
}

function zonedParts(nowMs, timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    weekday: 'short',
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(nowMs)).map(part => [part.type, part.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute),
    weekday: WEEKDAY[String(parts.weekday || '').slice(0, 3).toUpperCase()],
  };
}

function parseClock(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function pad(value) { return String(value).padStart(2, '0'); }

module.exports = { isInstrumentSessionOpen, assertInstrumentSessionOpen, parseClock, zonedParts };
