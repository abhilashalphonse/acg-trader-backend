'use strict';

const { z } = require('zod');
require('dotenv').config();

const REQUIRED_TIMEFRAMES = Object.freeze(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w']);
const SUPPORTED_TIMEFRAMES = new Set(REQUIRED_TIMEFRAMES);
const LEGACY_SUBMINUTE_TIMEFRAMES = new Set(['1s', '5s', '15s', '30s']);
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
  RECONCILIATION_ENABLED: booleanFromEnv.default(true),
  RECONCILIATION_INTERVAL_MS: positiveInt(300000),
  AUTH_SESSION_TTL_SECONDS: positiveInt(3600),
  AUTH_ACCESS_TOKEN_TTL_SECONDS: positiveInt(900),
  AUTH_REFRESH_SESSION_TTL_SECONDS: positiveInt(2592000),
  AUTH_IDLE_TIMEOUT_SECONDS: positiveInt(86400),
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
  PLATFORM_SNAPSHOT_COALESCE_MS: positiveInt(5000),
  MARKET_GATEWAY_ENABLED: booleanFromEnv.default(true),
  MARKET_PROVIDER: z.enum(['twelve-data']).default('twelve-data'),
  MARKET_UNIVERSE_MODE: z.enum(['catalog', 'explicit']).default('catalog'),
  MARKET_SYMBOLS: z.string().default('EURUSD,XAUUSD'),
  MARKET_CANDLE_TIMEFRAMES: z.string().default('1m,5m,15m,30m,1h,4h,1d,1w'),
  MARKET_PERSIST_TIMEFRAMES: z.string().default('1m,5m,15m,30m,1h,4h,1d,1w'),
  MARKET_DEFAULT_MAX_QUOTE_AGE_MS: positiveInt(5000),
  MARKET_STALE_CHECK_MS: positiveInt(1000),
  MARKET_CANDLE_FLUSH_INTERVAL_MS: positiveInt(250),
  MARKET_MAX_SYNTHETIC_GAP_BARS: z.coerce.number().int().min(0).max(1000).default(12),
  MARKET_WS_PATH: z.string().min(1).default('/v1/ws'),
  MARKET_WS_PING_INTERVAL_MS: positiveInt(30000),
  MARKET_WS_MAX_BUFFER_BYTES: positiveInt(1048576),
  MARKET_WS_QUOTE_COALESCE_MS: positiveInt(250),
  MARKET_WS_VALUATION_COALESCE_MS: positiveInt(250),
  TWELVE_DATA_API_KEY: z.string().optional(),
  TWELVE_DATA_WS_URL: z.string().url().default('wss://ws.twelvedata.com/v1/quotes/price'),
  TWELVE_DATA_API_BASE: z.string().url().default('https://api.twelvedata.com'),
  TWELVE_DATA_HEARTBEAT_MS: positiveInt(10000),
  TWELVE_DATA_RECONNECT_MIN_MS: positiveInt(1000),
  TWELVE_DATA_RECONNECT_MAX_MS: positiveInt(30000),
  TWELVE_DATA_HTTP_TIMEOUT_MS: positiveInt(10000),
  TWELVE_DATA_SUBSCRIBE_BATCH_SIZE: positiveInt(100),
});

const platformEventsExplicitlyConfigured = Object.prototype.hasOwnProperty.call(process.env, 'PLATFORM_EVENTS_ENABLED');

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const details = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new Error(`Invalid environment configuration: ${details}`);
}
const raw = parsed.data;
const symbols = [...new Set(csv(raw.MARKET_SYMBOLS).map(value => value.replace('/', '').toUpperCase()))];
const useCatalogUniverse = raw.MARKET_UNIVERSE_MODE === 'catalog';
const configuredCandleTimeframes = [...new Set(csv(raw.MARKET_CANDLE_TIMEFRAMES).map(value => value.toLowerCase()))]
  .filter(timeframe => !LEGACY_SUBMINUTE_TIMEFRAMES.has(timeframe));
const configuredPersistTimeframes = [...new Set(csv(raw.MARKET_PERSIST_TIMEFRAMES).map(value => value.toLowerCase()))]
  .filter(timeframe => !LEGACY_SUBMINUTE_TIMEFRAMES.has(timeframe));
for (const timeframe of [...configuredCandleTimeframes, ...configuredPersistTimeframes]) {
  if (!SUPPORTED_TIMEFRAMES.has(timeframe)) throw new Error(`Invalid market timeframe: ${timeframe}`);
}
// ACG Trader now exposes one canonical timeframe set. Unioning the required
// values also upgrades Railway deployments that still carry the legacy
// sub-minute environment strings, without requiring a coordinated env edit.
const candleTimeframes = [...new Set([...configuredCandleTimeframes, ...REQUIRED_TIMEFRAMES])];
const persistTimeframes = [...new Set([...configuredPersistTimeframes, ...REQUIRED_TIMEFRAMES])];
if (raw.MARKET_GATEWAY_ENABLED && !useCatalogUniverse && !symbols.length) throw new Error('MARKET_SYMBOLS must include at least one symbol when MARKET_UNIVERSE_MODE=explicit');
if (
  raw.MARKET_GATEWAY_ENABLED
  && raw.MARKET_PROVIDER === 'twelve-data'
  && (!raw.TWELVE_DATA_API_KEY || /^(your_|<)/i.test(raw.TWELVE_DATA_API_KEY))
) throw new Error('TWELVE_DATA_API_KEY is required when MARKET_GATEWAY_ENABLED=true');
if (!raw.MARKET_WS_PATH.startsWith('/')) throw new Error('MARKET_WS_PATH must start with /');
if (raw.TWELVE_DATA_RECONNECT_MAX_MS < raw.TWELVE_DATA_RECONNECT_MIN_MS) throw new Error('TWELVE_DATA_RECONNECT_MAX_MS must be >= TWELVE_DATA_RECONNECT_MIN_MS');
const resolvedPlatformEventsEnabled = platformEventsExplicitlyConfigured
  ? raw.PLATFORM_EVENTS_ENABLED
  : Boolean(raw.ACG_FUNDED_WEBHOOK_URL && raw.ACG_FUNDED_WEBHOOK_SECRET);
if (
  resolvedPlatformEventsEnabled
  && (
    !raw.ACG_FUNDED_WEBHOOK_URL
    || !raw.ACG_FUNDED_WEBHOOK_SECRET
    || /^</.test(raw.ACG_FUNDED_WEBHOOK_SECRET)
    || /example\.com/i.test(raw.ACG_FUNDED_WEBHOOK_URL)
  )
) {
  throw new Error('A real ACG_FUNDED_WEBHOOK_URL and ACG_FUNDED_WEBHOOK_SECRET are required when platform events are enabled');
}
if (/</.test(raw.MONGODB_URI)) throw new Error('MONGODB_URI still contains an example placeholder');

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
  reconciliation: Object.freeze({ enabled: raw.RECONCILIATION_ENABLED, intervalMs: raw.RECONCILIATION_INTERVAL_MS }),
  auth: Object.freeze({
    sessionTtlSeconds: raw.AUTH_SESSION_TTL_SECONDS,
    accessTokenTtlSeconds: raw.AUTH_ACCESS_TOKEN_TTL_SECONDS,
    refreshSessionTtlSeconds: raw.AUTH_REFRESH_SESSION_TTL_SECONDS,
    idleTimeoutSeconds: raw.AUTH_IDLE_TIMEOUT_SECONDS,
    federationTicketTtlSeconds: raw.AUTH_FEDERATION_TICKET_TTL_SECONDS,
    maxFailedLogins: raw.AUTH_MAX_FAILED_LOGINS,
    lockoutSeconds: raw.AUTH_LOCKOUT_SECONDS,
  }),
  platformEvents: Object.freeze({
    enabled: resolvedPlatformEventsEnabled,
    webhookUrl: raw.ACG_FUNDED_WEBHOOK_URL || null,
    webhookSecret: raw.ACG_FUNDED_WEBHOOK_SECRET || null,
    pollIntervalMs: raw.PLATFORM_EVENT_POLL_INTERVAL_MS,
    timeoutMs: raw.PLATFORM_EVENT_TIMEOUT_MS,
    batchSize: raw.PLATFORM_EVENT_BATCH_SIZE,
    maxAttempts: raw.PLATFORM_EVENT_MAX_ATTEMPTS,
    snapshotCoalesceMs: raw.PLATFORM_SNAPSHOT_COALESCE_MS,
  }),
  market: Object.freeze({
    enabled: raw.MARKET_GATEWAY_ENABLED,
    provider: raw.MARKET_PROVIDER,
    universeMode: raw.MARKET_UNIVERSE_MODE,
    useCatalogUniverse,
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
    wsQuoteCoalesceMs: raw.MARKET_WS_QUOTE_COALESCE_MS,
    wsValuationCoalesceMs: raw.MARKET_WS_VALUATION_COALESCE_MS,
  }),
  twelveData: Object.freeze({
    apiKey: raw.TWELVE_DATA_API_KEY || null,
    wsUrl: raw.TWELVE_DATA_WS_URL,
    apiBase: raw.TWELVE_DATA_API_BASE,
    heartbeatMs: raw.TWELVE_DATA_HEARTBEAT_MS,
    reconnectMinMs: raw.TWELVE_DATA_RECONNECT_MIN_MS,
    reconnectMaxMs: raw.TWELVE_DATA_RECONNECT_MAX_MS,
    httpTimeoutMs: raw.TWELVE_DATA_HTTP_TIMEOUT_MS,
    subscribeBatchSize: raw.TWELVE_DATA_SUBSCRIBE_BATCH_SIZE,
  }),
});

module.exports = { env, SUPPORTED_TIMEFRAMES, REQUIRED_TIMEFRAMES };
