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
  if (holidays.includes(dateKey) && !instrument.sessionOverrides?.some(item => item.date === dateKey)) return false;

  if (instrument.sessionOverrides?.length) {
    const windows = [...sessionWindowsOnDate(instrument, local), ...sessionWindowsOnDate(instrument, addLocalCalendarDays(local, -1))];
    const override = instrument.sessionOverrides.find(item => item.date === dateKey);
    if (override?.closed) return false;
    if (!override && !instrument.tradingSessions?.length) return true;
    return windows.some(window => nowMs >= window.openMs && nowMs < window.closeMs);
  }
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
      if (days.includes(currentDay) && isSameDayMinuteOpen(minuteOfDay, open, close)) return true;
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

function zonedDateTimeToUtcMs({ year, month, day, hour, minute }, timezone) {
  const targetWallClockMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = targetWallClockMs;

  for (let iteration = 0; iteration < 4; iteration += 1) {
    const local = zonedParts(guess, timezone);
    const observedWallClockMs = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      0,
      0,
    );
    const delta = observedWallClockMs - targetWallClockMs;
    if (delta === 0) return guess;
    guess -= delta;
  }

  return guess;
}

function activeSessionOpenTimeMs(instrument, nowMs) {
  if (!instrument) return null;
  if (instrument.sessionOverrides?.length) {
    if (!isInstrumentSessionOpen(instrument, nowMs)) return null;
    const local = zonedParts(nowMs, String(instrument.timezone || 'UTC'));
    return [...sessionWindowsOnDate(instrument, local), ...sessionWindowsOnDate(instrument, addLocalCalendarDays(local, -1))].find(window => nowMs >= window.openMs && nowMs < window.closeMs)?.openMs ?? null;
  }

  const timezone = String(instrument.timezone || 'UTC');
  const sessions = Array.isArray(instrument.tradingSessions) ? instrument.tradingSessions : [];
  if (!sessions.length) return null;

  const local = zonedParts(nowMs, timezone);
  const minuteOfDay = local.hour * 60 + local.minute;
  const currentDay = local.weekday;
  const previousDay = (currentDay + 6) % 7;

  for (const session of sessions) {
    const days = Array.isArray(session.days) ? session.days.map(Number) : [];
    const open = parseClock(session.open);
    const close = parseClock(session.close);
    if (open == null || close == null) continue;

    if (open <= close) {
      if (!days.includes(currentDay) || !isSameDayMinuteOpen(minuteOfDay, open, close)) continue;
      return zonedDateTimeToUtcMs({
        year: local.year,
        month: local.month,
        day: local.day,
        hour: Math.floor(open / 60),
        minute: open % 60,
      }, timezone);
    }

    if (days.includes(currentDay) && minuteOfDay >= open) {
      return zonedDateTimeToUtcMs({
        year: local.year,
        month: local.month,
        day: local.day,
        hour: Math.floor(open / 60),
        minute: open % 60,
      }, timezone);
    }

    if (days.includes(previousDay) && minuteOfDay < close) {
      const previousLocal = zonedParts(nowMs - 24 * 60 * 60 * 1000, timezone);
      return zonedDateTimeToUtcMs({
        year: previousLocal.year,
        month: previousLocal.month,
        day: previousLocal.day,
        hour: Math.floor(open / 60),
        minute: open % 60,
      }, timezone);
    }
  }

  return null;
}

function sessionAlignedBucketOpenTimeMs(instrument, timeMs, stepMs) {
  const numericTime = Number(timeMs);
  const numericStep = Number(stepMs);
  if (!Number.isFinite(numericTime) || !Number.isFinite(numericStep) || numericStep <= 0) return null;

  const sessionOpenMs = activeSessionOpenTimeMs(instrument, numericTime);
  if (!Number.isFinite(sessionOpenMs) || numericTime < sessionOpenMs) return null;

  return sessionOpenMs + Math.floor((numericTime - sessionOpenMs) / numericStep) * numericStep;
}

function sessionsOnDate(instrument, date) {
  const key = `${date.year}-${pad(date.month)}-${pad(date.day)}`;
  const override = (instrument.sessionOverrides || []).find(item => item.date === key);
  if (override) return override.closed ? [] : (override.sessions || []);
  if ((instrument.tradingHolidays || []).map(String).includes(key)) return [];
  const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return (instrument.tradingSessions || []).filter(session => (session.days || []).map(Number).includes(weekday));
}

function sessionWindowsOnDate(instrument, date) {
  const timezone = String(instrument.timezone || 'UTC');
  return sessionsOnDate(instrument, date).flatMap(session => {
    const open = parseClock(session.open);
    const close = parseClock(session.close);
    if (open == null || close == null) return [];
    const endsAtMidnight = close === 23 * 60 + 59;
    const endDate = open > close || endsAtMidnight ? addLocalCalendarDays(date, 1) : date;
    const openMs = zonedDateTimeToUtcMs({ ...date, hour: Math.floor(open / 60), minute: open % 60 }, timezone);
    const closeMs = zonedDateTimeToUtcMs({ ...endDate, hour: endsAtMidnight ? 0 : Math.floor(close / 60), minute: endsAtMidnight ? 0 : close % 60 }, timezone);
    return closeMs > openMs ? [{ openMs, closeMs }] : [];
  });
}

function nextWeekendCloseTimeMs(instrument, nowMs = Date.now()) {
  if (!instrument?.tradingSessions?.length) return null;
  // Continuous/weekend trading needs an explicit product schedule; do not invent a crypto cutoff.
  if (instrument.tradingSessions.some(session => (session.days || []).map(Number).includes(WEEKDAY.SAT))) return null;
  const local = zonedParts(nowMs, String(instrument.timezone || 'UTC'));
  const monday = addLocalCalendarDays(local, -((local.weekday + 6) % 7));
  for (let week = 0; week < 8; week++) {
    const windows = [];
    for (let day = 0; day < 5; day++) windows.push(...sessionWindowsOnDate(instrument, addLocalCalendarDays(monday, week * 7 + day)));
    const finalClose = windows.length ? Math.max(...windows.map(window => window.closeMs)) : null;
    if (finalClose != null && finalClose > nowMs) return finalClose;
  }
  return null;
}

function nextSessionOpenTimeMs(instrument, afterMs) {
  const local = zonedParts(afterMs, String(instrument.timezone || 'UTC'));
  for (let day = 0; day < 15; day++) {
    const candidates = sessionWindowsOnDate(instrument, addLocalCalendarDays(local, day))
      .map(window => window.openMs).filter(open => open >= afterMs);
    if (candidates.length) return Math.min(...candidates);
  }
  return null;
}

function addLocalCalendarDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + Number(days || 0)));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function isSameDayMinuteOpen(minuteOfDay, open, close) {
  // Session configuration is minute-granular and cannot represent 24:00.
  // Treat 23:59 as the end-of-day sentinel so an intended all-day session
  // does not create a false one-minute closure from 23:59:00 to midnight.
  const closeExclusive = close === 23 * 60 + 59 ? 24 * 60 : close;
  return minuteOfDay >= open && minuteOfDay < closeExclusive;
}

function candleOverlapsInstrumentSession(instrument, openTimeMs, closeTimeMs) {
  const openMs = Number(openTimeMs);
  const closeMs = Number(closeTimeMs);
  if (!Number.isFinite(openMs) || !Number.isFinite(closeMs) || closeMs <= openMs) return true;
  if (isInstrumentSessionOpen(instrument, openMs)) return true;

  // Session configuration is minute-granular. Probe minute boundaries through
  // the candle interval so higher-timeframe bars that contain the reopening
  // (for example Sunday 20:00-00:00 H4) are preserved.
  const minuteMs = 60 * 1000;
  const firstWholeMinute = Math.floor(openMs / minuteMs) * minuteMs + minuteMs;
  for (let probe = firstWholeMinute; probe < closeMs; probe += minuteMs) {
    if (isInstrumentSessionOpen(instrument, probe)) return true;
  }

  return isInstrumentSessionOpen(instrument, closeMs - 1);
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

module.exports = { isInstrumentSessionOpen, assertInstrumentSessionOpen, candleOverlapsInstrumentSession, parseClock, zonedParts, zonedDateTimeToUtcMs, activeSessionOpenTimeMs, sessionAlignedBucketOpenTimeMs, nextWeekendCloseTimeMs, nextSessionOpenTimeMs };
