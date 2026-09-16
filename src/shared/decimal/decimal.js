'use strict';

const mongoose = require('mongoose');

const POW10_CACHE = [1n];
const ROUNDING = Object.freeze({
  DOWN: 'DOWN',
  HALF_UP: 'HALF_UP',
  FLOOR: 'FLOOR',
  CEIL: 'CEIL',
});

function pow10(exponent) {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 10_000) {
    throw new RangeError(`Invalid decimal exponent: ${exponent}`);
  }
  for (let index = POW10_CACHE.length; index <= exponent; index += 1) {
    POW10_CACHE[index] = POW10_CACHE[index - 1] * 10n;
  }
  return POW10_CACHE[exponent];
}

function inputToString(value) {
  if (value === null || value === undefined) throw new TypeError('Decimal value is required');
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Decimal number must be finite');
    return value.toString();
  }
  if (value?._bsontype === 'Decimal128' || value?.constructor?.name === 'Decimal128') return value.toString();
  if (typeof value.toString === 'function') return value.toString().trim();
  throw new TypeError('Unsupported decimal value');
}

function normalizeParts(coefficient, scale) {
  if (coefficient === 0n) return { coefficient: 0n, scale: 0 };
  let nextCoefficient = coefficient;
  let nextScale = scale;
  while (nextScale > 0 && nextCoefficient % 10n === 0n) {
    nextCoefficient /= 10n;
    nextScale -= 1;
  }
  return { coefficient: nextCoefficient, scale: nextScale };
}

function parseDecimal(value) {
  const source = inputToString(value);
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!match) throw new TypeError(`Invalid decimal value: ${source}`);

  const negative = match[1] === '-';
  const integer = match[2];
  const fraction = match[3] || '';
  const exponent = Number(match[4] || 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10_000) {
    throw new RangeError(`Decimal exponent is out of range: ${match[4]}`);
  }

  const digits = `${integer}${fraction}`.replace(/^0+(?=\d)/, '') || '0';
  let coefficient = BigInt(digits);
  if (negative) coefficient = -coefficient;
  let scale = fraction.length - exponent;
  if (scale < 0) {
    coefficient *= pow10(-scale);
    scale = 0;
  }
  return normalizeParts(coefficient, scale);
}

function formatDecimalParts(parts) {
  const normalized = normalizeParts(parts.coefficient, parts.scale);
  const negative = normalized.coefficient < 0n;
  let digits = (negative ? -normalized.coefficient : normalized.coefficient).toString();
  if (normalized.scale === 0) return `${negative ? '-' : ''}${digits}`;

  if (digits.length <= normalized.scale) {
    digits = `${'0'.repeat(normalized.scale - digits.length + 1)}${digits}`;
  }
  const split = digits.length - normalized.scale;
  return `${negative ? '-' : ''}${digits.slice(0, split)}.${digits.slice(split)}`;
}

function normalizeDecimal(value) {
  return formatDecimalParts(parseDecimal(value));
}

function align(a, b) {
  const scale = Math.max(a.scale, b.scale);
  return {
    scale,
    a: a.coefficient * pow10(scale - a.scale),
    b: b.coefficient * pow10(scale - b.scale),
  };
}

function addDecimal(left, right) {
  const aligned = align(parseDecimal(left), parseDecimal(right));
  return formatDecimalParts({ coefficient: aligned.a + aligned.b, scale: aligned.scale });
}

function subtractDecimal(left, right) {
  const aligned = align(parseDecimal(left), parseDecimal(right));
  return formatDecimalParts({ coefficient: aligned.a - aligned.b, scale: aligned.scale });
}

function multiplyDecimal(left, right) {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  return formatDecimalParts({ coefficient: a.coefficient * b.coefficient, scale: a.scale + b.scale });
}

function divideDecimal(left, right, { scale = 18, rounding = ROUNDING.HALF_UP } = {}) {
  if (!Number.isInteger(scale) || scale < 0 || scale > 100) throw new RangeError('Division scale must be between 0 and 100');
  if (!Object.values(ROUNDING).includes(rounding)) throw new TypeError(`Unsupported rounding mode: ${rounding}`);

  const a = parseDecimal(left);
  const b = parseDecimal(right);
  if (b.coefficient === 0n) throw new RangeError('Division by zero');
  if (a.coefficient === 0n) return '0';

  const negative = (a.coefficient < 0n) !== (b.coefficient < 0n);
  let numerator = a.coefficient < 0n ? -a.coefficient : a.coefficient;
  let denominator = b.coefficient < 0n ? -b.coefficient : b.coefficient;
  const exponent = b.scale + scale - a.scale;
  if (exponent >= 0) numerator *= pow10(exponent);
  else denominator *= pow10(-exponent);

  let quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder !== 0n && shouldRoundUp({ quotient, remainder, denominator, negative, rounding })) quotient += 1n;
  if (negative) quotient = -quotient;
  return formatDecimalParts({ coefficient: quotient, scale });
}

function shouldRoundUp({ remainder, denominator, negative, rounding }) {
  switch (rounding) {
    case ROUNDING.DOWN: return false;
    case ROUNDING.HALF_UP: return remainder * 2n >= denominator;
    case ROUNDING.FLOOR: return negative;
    case ROUNDING.CEIL: return !negative;
    default: return false;
  }
}

function compareDecimal(left, right) {
  const aligned = align(parseDecimal(left), parseDecimal(right));
  if (aligned.a === aligned.b) return 0;
  return aligned.a > aligned.b ? 1 : -1;
}

function isStepAligned(value, step) {
  const parsedStep = parseDecimal(step);
  if (parsedStep.coefficient <= 0n) throw new RangeError('Step must be greater than zero');
  const aligned = align(parseDecimal(value), parsedStep);
  return aligned.a % aligned.b === 0n;
}

function quantizeToStep(value, step, rounding = ROUNDING.DOWN) {
  const units = divideDecimal(value, step, { scale: 0, rounding });
  return multiplyDecimal(units, step);
}

function assertPositiveDecimal(value, fieldName = 'value') {
  const normalized = normalizeDecimal(value);
  if (compareDecimal(normalized, '0') <= 0) throw new RangeError(`${fieldName} must be greater than zero`);
  return normalized;
}

function toDecimal128(value) {
  return mongoose.Types.Decimal128.fromString(normalizeDecimal(value));
}

function fromDecimal128(value) {
  return value == null ? null : normalizeDecimal(value.toString());
}

module.exports = {
  ROUNDING,
  parseDecimal,
  normalizeDecimal,
  addDecimal,
  subtractDecimal,
  multiplyDecimal,
  divideDecimal,
  compareDecimal,
  isStepAligned,
  quantizeToStep,
  assertPositiveDecimal,
  toDecimal128,
  fromDecimal128,
};
