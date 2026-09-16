'use strict';

const { z } = require('zod');
require('dotenv').config();

const booleanFromEnv = z.preprocess(value => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return value;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}, z.boolean());

const positiveInt = defaultValue => z.coerce.number().int().positive().default(defaultValue);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: booleanFromEnv.default(false),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  SHUTDOWN_TIMEOUT_MS: positiveInt(10000),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  MONGODB_SERVER_SELECTION_TIMEOUT_MS: positiveInt(5000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const details = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new Error(`Invalid environment configuration: ${details}`);
}

const raw = parsed.data;
const env = Object.freeze({
  nodeEnv: raw.NODE_ENV,
  isProduction: raw.NODE_ENV === 'production',
  port: raw.PORT,
  logLevel: raw.LOG_LEVEL,
  trustProxy: raw.TRUST_PROXY,
  corsOrigins: raw.CORS_ORIGINS.split(',').map(value => value.trim()).filter(Boolean),
  shutdownTimeoutMs: raw.SHUTDOWN_TIMEOUT_MS,
  mongoUri: raw.MONGODB_URI,
  mongoServerSelectionTimeoutMs: raw.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
});

module.exports = { env };
