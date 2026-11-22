'use strict';

// Pure alert evaluator. No database, clock, network or notification side effects.
// All numeric comparisons are quantized using the instrument tick size.
const QUOTE_KINDS = new Set(['crosses', 'crosses_above', 'crosses_below', 'enters_range', 'exits_range']);
const CANDLE_KINDS = new Set(['candle_close_above', 'candle_close_below']);

function decimalParts(value) {
  const raw = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(raw);
  if (!match) throw new Error('Invalid decimal: ' + raw);
  const negative = match[1] === '-';
  const whole = match[2], fractional = match[3] || '';
  const exponent = Number(match[4] || 0);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 30) throw new Error('Invalid decimal exponent');
  const effectiveDigits = fractional.length - exponent;
  const digits = Math.max(0, effectiveDigits);
  const zeros = Math.max(0, -effectiveDigits);
  return { integer: BigInt(whole + fractional + '0'.repeat(zeros)) * (negative ? -1n : 1n), digits };
}

function ticks(value, tickSize) {
  const a = decimalParts(value);
  const b = decimalParts(tickSize);
  if (b.integer <= 0n) throw new Error('Invalid tick size');
  const n = a.integer * (10n ** BigInt(b.digits));
  const d = b.integer * (10n ** BigInt(a.digits));
  const positive = n >= 0n;
  const absolute = positive ? n : -n;
  const rounded = (absolute * 2n + d) / (2n * d);
  return (positive ? rounded : -rounded).toString();
}

function compare(x, y) {
  const a = BigInt(x), b = BigInt(y);
  return a < b ? -1 : a > b ? 1 : 0;
}

function emptyState() {
  return { baselineTicks: null, armed: true, lastEventId: null, lastTriggerMs: null,
    monitoring: 'STARTING', lastObservedMs: null, lastTriggerEventId: null };
}

function scheduleAllows(schedule, ms) {
  if (!schedule) return true;
  const zone = schedule.timezone || 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const read = type => parts.find(item => item.type === type)?.value;
  const day = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(read('weekday'));
  const minute = Number(read('hour')) * 60 + Number(read('minute'));
  const days = Array.isArray(schedule.days) ? schedule.days : [0,1,2,3,4,5,6];
  if (!days.includes(day)) return false;
  const start = Number(schedule.startMinute ?? 0), end = Number(schedule.endMinute ?? 1440);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 1440 || start >= end) {
    throw new Error('Schedule must be a non-wrapping interval within a day');
  }
  return minute >= start && minute < end;
}

function evaluateAlert(rule, previous, event) {
  const state = { ...emptyState(), ...(previous || {}) };
  if (!event?.eventId || !Number.isFinite(Number(event.marketTimeMs))) throw new Error('Durable event identity and market timestamp required');
  if (event.eventId === state.lastEventId) return { state, trigger: null };
  if (String(event.streamId) !== String(rule.streamId)) return { state, trigger: null };
  const next = { ...state, lastEventId: event.eventId, lastObservedMs: event.marketTimeMs };
  if (event.kind === 'coverage_gap') {
    return { state: { ...next, baselineTicks: null, armed: true, monitoring: 'INTERRUPTED' }, trigger: null };
  }
  if (event.kind === 'candle_corrected') {
    return { state: next, trigger: null };
  }

  const type = rule.condition?.type;
  if (!QUOTE_KINDS.has(type) && !CANDLE_KINDS.has(type)) throw new Error('Unsupported alert condition');
  const candle = CANDLE_KINDS.has(type);
  if ((candle && event.kind !== 'candle_closed') || (!candle && event.kind !== 'quote')) {
    return { state: next, trigger: null };
  }
  if (candle && (event.timeframe !== rule.timeframe || event.synthetic || event.complete !== true)) {
    return { state: next, trigger: null };
  }
  if (candle && rule.priceSource !== 'last') throw new Error('ACG-finalised candles currently support Last only');

  const raw = candle ? event.close : event.prices?.[rule.priceSource];
  if (raw == null || raw === '') {
    return { state: { ...next, monitoring: 'SOURCE_UNAVAILABLE', baselineTicks: null, armed: true }, trigger: null };
  }

  const current = ticks(raw, rule.tickSize);
  const threshold = type.includes('range')
    ? null : ticks(rule.condition.level, rule.tickSize);
  const lower = type.includes('range') ? ticks(rule.condition.lower, rule.tickSize) : null;
  const upper = type.includes('range') ? ticks(rule.condition.upper, rule.tickSize) : null;
  if (lower !== null && compare(lower, upper) >= 0) throw new Error('Range lower must be below upper');
  const prev = state.baselineTicks;
  const earlier = prev === null ? null : BigInt(prev);
  const value = BigInt(current);
  const level = threshold === null ? null : BigInt(threshold);
  const inside = value => value >= BigInt(lower) && value <= BigInt(upper);
  let candidate = false, reset = false;
  switch (type) {
    case 'crosses_above':
      candidate = earlier !== null && earlier < level && value >= level;
      reset = value < level;
      break;
    case 'crosses_below':
      candidate = earlier !== null && earlier > level && value <= level;
      reset = value > level;
      break;
    case 'crosses':
      candidate = earlier !== null && ((earlier < level && value >= level) || (earlier > level && value <= level));
      reset = earlier !== null && ((earlier < level && value < level) || (earlier > level && value > level));
      break;
    case 'enters_range':
      candidate = earlier !== null && !inside(earlier) && inside(value);
      reset = !inside(value);
      break;
    case 'exits_range':
      candidate = earlier !== null && inside(earlier) && !inside(value);
      reset = inside(value);
      break;
    case 'candle_close_above':
      candidate = value > level;
      reset = value <= level;
      break;
    case 'candle_close_below':
      candidate = value < level;
      reset = value >= level;
      break;
    default: throw new Error('Unsupported alert condition');
  }
  const wasInterrupted = state.monitoring === 'INTERRUPTED' || state.monitoring === 'SOURCE_UNAVAILABLE';
  if (wasInterrupted && !candle) candidate = false; // fresh baseline after gaps
  if (rule.frequency === 'repeat' && !state.armed && reset) next.armed = true;
  next.baselineTicks = current;
  next.monitoring = 'MONITORING';
  const expired = rule.expiresAt != null && event.marketTimeMs >= new Date(rule.expiresAt).getTime();
  if (expired) return { state: { ...next, monitoring: 'EXPIRED' }, trigger: null };
  if (!scheduleAllows(rule.schedule, event.marketTimeMs)) {
    // Still update baseline: reopening a schedule must not fabricate a crossing.
    return { state: next, trigger: null };
  }
  const repeat = rule.frequency === 'repeat';
  const eligible = candidate && (repeat ? next.armed : state.lastTriggerMs == null);
  if (!eligible) return { state: next, trigger: null };
  const cooldownMs = Math.max(0, Number(rule.cooldownMs || 0));
  const cooled = state.lastTriggerMs == null || event.marketTimeMs - state.lastTriggerMs >= cooldownMs;
  if (repeat) next.armed = false; // a suppressed crossing still requires another reset
  if (!cooled) return { state: next, trigger: null };
  next.lastTriggerMs = event.marketTimeMs;
  next.lastTriggerEventId = event.eventId;
  if (!repeat) next.monitoring = 'COMPLETED';
  return {
    state: next,
    trigger: {
      eventId: event.eventId, ruleVersion: rule.version, alertId: String(rule._id || rule.id),
      streamId: event.streamId, marketTimeMs: event.marketTimeMs, acceptedAtMs: event.acceptedAtMs,
      observedTicks: current, previousTicks: prev, condition: { ...rule.condition },
      priceSource: rule.priceSource, timeframe: candle ? rule.timeframe : null,
      quality: event.quality || 'LIVE',
    },
  };
}

module.exports = { evaluateAlert, emptyState, ticks, compare, scheduleAllows };
