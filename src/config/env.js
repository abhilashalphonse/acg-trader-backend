'use strict';

const { z } = require('zod');
require('dotenv').config();

const SUPPORTED_TIMEFRAMES = new Set(['1s', '5s', '15s', '30s', '1m', '5m', '15m', '1h', '4h', '1d']);
const booleanFromEnv = z.preprocess(value => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return value;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}, z.boolean());
const positiveInt = defaultValue => z.coerce.number().int().positive().default(defaultValue);
const csv = value => String(value || '').split(',').map(item => item.trim()).filter(Boolean);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: booleanFromEnv.default(false),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  SHUTDOWN_TIMEOUT_MS: positiveInt(10000),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  MONGODB_SERVER_SELECTION_TIMEOUT_MS: positiveInt(5000),
  INSTRUMENT_CATALOG_AUTO_SEED: booleanFromEnv.default(true),
  TRADING_API_ENABLED: booleanFromEnv.default(false),
  AUTH_SESSION_TTL_SECONDS: positiveInt(3600),
  AUTH_FEDERATION_TICKET_TTL_SECONDS: positiveInt(60),
  AUTH_MAX_FAILED_LOGINS: positiveInt(5),
  AUTH_LOCKOUT_SECONDS: positiveInt(900),
  PLATFORM_EVENTS_ENABLED: booleanFromEnv.default(false),
  ACG_FUNDED_WEBHOOK_URL: z.string().url().optional(),
  ACG_FUNDED_WEBHOOK_SECRET: z.string().min(16).optional(),
  PLATFORM_EVENT_POLL_INTERVAL_MS: positiveInt(1000),
  PLATFORM_EVENT_TIMEOUT_MS: positiveInt(5000),
  PLATFORM_EVENT_BATCH_SIZE: positiveInt(100),
  PLATFORM_EVENT_MAX_ATTEMPTS: positiveInt(12),
  MARKET_GATEWAY_ENABLED: booleanFromEnv.default(true),
  MARKET_PROVIDER: z.enum(['twelve-data']).default('twelve-data'),
  MARKET_SYMBOLS: z.string().default('EURUSD,XAUUSD'),
  MARKET_CANDLE_TIMEFRAMES: z.string().default('1s,5s,15s,30s,1m,5m,15m,1h,4h,1d'),
  MARKET_PERSIST_TIMEFRAMES: z.string().default('5s,15s,30s,1m,5m,15m,1h,4h,1d'),
  MARKET_DEFAULT_MAX_QUOTE_AGE_MS: positiveInt(5000),
  MARKET_STALE_CHECK_MS: positiveInt(1000),
  MARKET_CANDLE_FLUSH_INTERVAL_MS: positiveInt(250),
  MARKET_MAX_SYNTHETIC_GAP_BARS: z.coerce.number().int().min(0).max(1000).default(12),
  MARKET_WS_PATH: z.string().min(1).default('/v1/ws'),
  MARKET_WS_PING_INTERVAL_MS: positiveInt(30000),
  MARKET_WS_MAX_BUFFER_BYTES: positiveInt(1048576),
  TWELVE_DATA_API_KEY: z.string().optional(),
  TWELVE_DATA_WS_URL: z.string().url().default('wss://ws.twelvedata.com/v1/quotes/price'),
  TWELVE_DATA_API_BASE: z.string().url().default('https://api.twelvedata.com'),
  TWELVE_DATA_HEARTBEAT_MS: positiveInt(10000),
  TWELVE_DATA_RECONNECT_MIN_MS: positiveInt(1000),
  TWELVE_DATA_RECONNECT_MAX_MS: positiveInt(30000),
  TWELVE_DATA_HTTP_TIMEOUT_MS: positiveInt(10000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const details = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new Error(`Invalid environment configuration: ${details}`);
}
const raw = parsed.data;
const symbols = [...new Set(csv(raw.MARKET_SYMBOLS).map(value => value.replace('/', '').toUpperCase()))];
const candleTimeframes = [...new Set(csv(raw.MARKET_CANDLE_TIMEFRAMES).map(value => value.toLowerCase()))];
const persistTimeframes = [...new Set(csv(raw.MARKET_PERSIST_TIMEFRAMES).map(value => value.toLowerCase()))];
for (const timeframe of [...candleTimeframes, ...persistTimeframes]) if (!SUPPORTED_TIMEFRAMES.has(timeframe)) throw new Error(`Invalid market timeframe: ${timeframe}`);
for (const timeframe of persistTimeframes) if (!candleTimeframes.includes(timeframe)) throw new Error(`Persist timeframe ${timeframe} must also be in MARKET_CANDLE_TIMEFRAMES`);
if (raw.MARKET_GATEWAY_ENABLED && !symbols.length) throw new Error('MARKET_SYMBOLS must include at least one symbol');
if (raw.MARKET_GATEWAY_ENABLED && raw.MARKET_PROVIDER === 'twelve-data' && (!raw.TWELVE_DATA_API_KEY || raw.TWELVE_DATA_API_KEY === 'your_api_key_here')) throw new Error('TWELVE_DATA_API_KEY is required when MARKET_GATEWAY_ENABLED=true');
if (!raw.MARKET_WS_PATH.startsWith('/')) throw new Error('MARKET_WS_PATH must start with /');
if (raw.TWELVE_DATA_RECONNECT_MAX_MS < raw.TWELVE_DATA_RECONNECT_MIN_MS) throw new Error('TWELVE_DATA_RECONNECT_MAX_MS must be >= TWELVE_DATA_RECONNECT_MIN_MS');
if (raw.PLATFORM_EVENTS_ENABLED && (!raw.ACG_FUNDED_WEBHOOK_URL || !raw.ACG_FUNDED_WEBHOOK_SECRET)) throw new Error('ACG_FUNDED_WEBHOOK_URL and ACG_FUNDED_WEBHOOK_SECRET are required when PLATFORM_EVENTS_ENABLED=true');

const env = Object.freeze({
  nodeEnv: raw.NODE_ENV,
  isProduction: raw.NODE_ENV === 'production',
  port: raw.PORT,
  logLevel: raw.LOG_LEVEL,
  trustProxy: raw.TRUST_PROXY,
  corsOrigins: csv(raw.CORS_ORIGINS),
  shutdownTimeoutMs: raw.SHUTDOWN_TIMEOUT_MS,
  mongoUri: raw.MONGODB_URI,
  mongoServerSelectionTimeoutMs: raw.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
  instrumentCatalogAutoSeed: raw.INSTRUMENT_CATALOG_AUTO_SEED,
  tradingApiEnabled: raw.TRADING_API_ENABLED,
  auth: Object.freeze({
    sessionTtlSeconds: raw.AUTH_SESSION_TTL_SECONDS,
    federationTicketTtlSeconds: raw.AUTH_FEDERATION_TICKET_TTL_SECONDS,
    maxFailedLogins: raw.AUTH_MAX_FAILED_LOGINS,
    lockoutSeconds: raw.AUTH_LOCKOUT_SECONDS,
  }),
  platformEvents: Object.freeze({
    enabled: raw.PLATFORM_EVENTS_ENABLED,
    webhookUrl: raw.ACG_FUNDED_WEBHOOK_URL || null,
    webhookSecret: raw.ACG_FUNDED_WEBHOOK_SECRET || null,
    pollIntervalMs: raw.PLATFORM_EVENT_POLL_INTERVAL_MS,
    timeoutMs: raw.PLATFORM_EVENT_TIMEOUT_MS,
    batchSize: raw.PLATFORM_EVENT_BATCH_SIZE,
    maxAttempts: raw.PLATFORM_EVENT_MAX_ATTEMPTS,
  }),
  market: Object.freeze({
    enabled: raw.MARKET_GATEWAY_ENABLED,
    provider: raw.MARKET_PROVIDER,
    symbols,
    candleTimeframes,
    persistTimeframes,
    defaultMaxQuoteAgeMs: raw.MARKET_DEFAULT_MAX_QUOTE_AGE_MS,
    staleCheckMs: raw.MARKET_STALE_CHECK_MS,
    candleFlushIntervalMs: raw.MARKET_CANDLE_FLUSH_INTERVAL_MS,
    maxSyntheticGapBars: raw.MARKET_MAX_SYNTHETIC_GAP_BARS,
    wsPath: raw.MARKET_WS_PATH,
    wsPingIntervalMs: raw.MARKET_WS_PING_INTERVAL_MS,
    wsMaxBufferBytes: raw.MARKET_WS_MAX_BUFFER_BYTES,
  }),
  twelveData: Object.freeze({
    apiKey: raw.TWELVE_DATA_API_KEY || null,
    wsUrl: raw.TWELVE_DATA_WS_URL,
    apiBase: raw.TWELVE_DATA_API_BASE,
    heartbeatMs: raw.TWELVE_DATA_HEARTBEAT_MS,
    reconnectMinMs: raw.TWELVE_DATA_RECONNECT_MIN_MS,
    reconnectMaxMs: raw.TWELVE_DATA_RECONNECT_MAX_MS,
    httpTimeoutMs: raw.TWELVE_DATA_HTTP_TIMEOUT_MS,
  }),
});

module.exports = { env, SUPPORTED_TIMEFRAMES };
