'use strict';

// ACG-owned simulated CFD product universe.
// Twelve Data is the market-data provider; these are ACG execution/product
// specifications and must not be treated as universal broker contract terms.
// New instruments are intentionally inserted with execution disabled. Operators
// can enable execution only after validating the provider feed and product terms.

const ACG_STANDARD_LEVERAGE = 100;

const FX_TIGHT_POINTS = Object.freeze({ EURUSD: 2, USDJPY: 2, GBPUSD: 3, AUDUSD: 3, USDCHF: 3, USDCAD: 3, NZDUSD: 4, EURGBP: 4, EURJPY: 4, GBPJPY: 6 });
const FX_EXOTIC_CURRENCIES = new Set(['CNH', 'CZK', 'DKK', 'HKD', 'HUF', 'MXN', 'NOK', 'PLN', 'SEK', 'SGD', 'TRY', 'ZAR']);
const FX_STRESSED_CURRENCIES = new Set(['MXN', 'TRY', 'ZAR']);
const FX_VOLUME_BANDS = Object.freeze([
  Object.freeze({ upTo: '1', extraPoints: '0' }),
  Object.freeze({ upTo: '5', extraPoints: '1' }),
  Object.freeze({ upTo: '15', extraPoints: '2' }),
  Object.freeze({ upTo: '30', extraPoints: '4' }),
  Object.freeze({ upTo: null, extraPoints: '8' }),
]);
const METAL_VOLUME_BANDS = Object.freeze([
  Object.freeze({ upTo: '1', extraPoints: '0' }),
  Object.freeze({ upTo: '5', extraPoints: '5' }),
  Object.freeze({ upTo: '15', extraPoints: '10' }),
  Object.freeze({ upTo: '30', extraPoints: '20' }),
  Object.freeze({ upTo: null, extraPoints: '40' }),
]);

const FX_WEEK = Object.freeze([
  Object.freeze({ days: [0], open: '22:00', close: '23:59' }),
  Object.freeze({ days: [1, 2, 3, 4], open: '00:00', close: '23:59' }),
  Object.freeze({ days: [5], open: '00:00', close: '22:00' }),
]);

const US_EQUITY_SESSION = Object.freeze([
  Object.freeze({ days: [1, 2, 3, 4, 5], open: '09:30', close: '16:00' }),
]);

const FOREX_PAIRS = Object.freeze([
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "USD/CHF",
  "AUD/USD",
  "NZD/USD",
  "USD/CAD",
  "EUR/GBP",
  "EUR/JPY",
  "EUR/CHF",
  "EUR/AUD",
  "EUR/NZD",
  "EUR/CAD",
  "GBP/JPY",
  "GBP/CHF",
  "GBP/AUD",
  "GBP/NZD",
  "GBP/CAD",
  "AUD/JPY",
  "AUD/CHF",
  "AUD/NZD",
  "AUD/CAD",
  "NZD/JPY",
  "NZD/CHF",
  "NZD/CAD",
  "CAD/JPY",
  "CAD/CHF",
  "CHF/JPY",
  "USD/SGD",
  "USD/HKD",
  "USD/CNH",
  "USD/MXN",
  "USD/ZAR",
  "USD/TRY",
  "USD/PLN",
  "USD/SEK",
  "USD/NOK",
  "USD/DKK",
  "USD/CZK",
  "USD/HUF",
  "EUR/SGD",
  "EUR/HKD",
  "EUR/CNH",
  "EUR/MXN",
  "EUR/ZAR",
  "EUR/TRY",
  "EUR/PLN",
  "EUR/SEK",
  "EUR/NOK",
  "EUR/DKK",
  "EUR/CZK",
  "EUR/HUF",
  "GBP/SGD",
  "GBP/HKD",
  "GBP/CNH",
  "GBP/MXN",
  "GBP/ZAR",
  "GBP/TRY",
  "GBP/PLN",
  "GBP/SEK",
  "GBP/NOK",
  "GBP/DKK",
  "GBP/CZK",
  "GBP/HUF",
  "AUD/SGD",
  "AUD/HKD",
  "AUD/CNH",
  "AUD/MXN",
  "AUD/ZAR",
  "AUD/SEK",
  "AUD/NOK",
  "NZD/SGD",
  "NZD/HKD",
  "NZD/CNH",
  "NZD/ZAR",
  "CAD/SGD",
  "CAD/HKD",
  "CAD/CNH",
  "CAD/MXN",
  "CAD/ZAR",
]);

const COMMODITIES = Object.freeze([
  Object.freeze({ symbol: "XAUUSD", providerSymbol: "XAU/USD", name: "Gold Spot / US Dollar", assetClass: "METAL", baseCurrency: "XAU", quoteCurrency: "USD", digits: 2, tickSize: "0.01", pipSize: "0.01", contractSize: "100", defaultLeverage: 100, fixedPoints: "30" }),
  Object.freeze({ symbol: "XAGUSD", providerSymbol: "XAG/USD", name: "Silver Spot / US Dollar", assetClass: "METAL", baseCurrency: "XAG", quoteCurrency: "USD", digits: 3, tickSize: "0.001", pipSize: "0.01", contractSize: "5000", defaultLeverage: 100, fixedPoints: "30" }),
  Object.freeze({ symbol: "XPTUSD", providerSymbol: "XPT/USD", name: "Platinum Spot / US Dollar", assetClass: "METAL", baseCurrency: "XPT", quoteCurrency: "USD", digits: 2, tickSize: "0.01", pipSize: "0.01", contractSize: "100", defaultLeverage: 50, fixedPoints: "30" }),
  Object.freeze({ symbol: "XPDUSD", providerSymbol: "XPD/USD", name: "Palladium Spot / US Dollar", assetClass: "METAL", baseCurrency: "XPD", quoteCurrency: "USD", digits: 2, tickSize: "0.01", pipSize: "0.01", contractSize: "100", defaultLeverage: 50, fixedPoints: "30" }),
  Object.freeze({ symbol: "WTIUSD", providerSymbol: "WTI/USD", name: "Crude Oil WTI Spot", assetClass: "ENERGY", baseCurrency: "WTI", quoteCurrency: "USD", digits: 3, tickSize: "0.001", pipSize: "0.01", contractSize: "1000", defaultLeverage: 20, fixedPoints: "20" }),
  Object.freeze({ symbol: "XBRUSD", providerSymbol: "XBR/USD", name: "Brent Spot / US Dollar", assetClass: "ENERGY", baseCurrency: "XBR", quoteCurrency: "USD", digits: 3, tickSize: "0.001", pipSize: "0.01", contractSize: "1000", defaultLeverage: 20, fixedPoints: "20" }),
  Object.freeze({ symbol: "NGASUSD", providerSymbol: "NG/USD", name: "Natural Gas", assetClass: "ENERGY", baseCurrency: "NG", quoteCurrency: "USD", digits: 3, tickSize: "0.001", pipSize: "0.01", contractSize: "10000", defaultLeverage: 20, fixedPoints: "20" }),
  Object.freeze({ symbol: "COPPER", providerSymbol: "HG1", name: "Copper", assetClass: "OTHER", baseCurrency: null, quoteCurrency: "USD", digits: 4, tickSize: "0.0001", pipSize: "0.0001", contractSize: "1", defaultLeverage: 20, fixedPoints: "10" }),
  Object.freeze({ symbol: "CORN", providerSymbol: "ZC1", name: "Corn", assetClass: "OTHER", baseCurrency: null, quoteCurrency: "USD", digits: 2, tickSize: "0.01", pipSize: "0.01", contractSize: "1", defaultLeverage: 10, fixedPoints: "10" }),
  Object.freeze({ symbol: "WHEAT", providerSymbol: "ZW1", name: "Wheat", assetClass: "OTHER", baseCurrency: null, quoteCurrency: "USD", digits: 2, tickSize: "0.01", pipSize: "0.01", contractSize: "1", defaultLeverage: 10, fixedPoints: "10" }),
  Object.freeze({ symbol: "SOYBEAN", providerSymbol: "ZS1", name: "Soybeans", assetClass: "OTHER", baseCurrency: null, quoteCurrency: "USD", digits: 2, tickSize: "0.01", pipSize: "0.01", contractSize: "1", defaultLeverage: 10, fixedPoints: "10" }),
  Object.freeze({ symbol: "SUGAR", providerSymbol: "SB1", name: "Sugar", assetClass: "OTHER", baseCurrency: null, quoteCurrency: "USD", digits: 4, tickSize: "0.0001", pipSize: "0.0001", contractSize: "1", defaultLeverage: 10, fixedPoints: "10" }),
  Object.freeze({ symbol: "COFFEE", providerSymbol: "KC1", name: "Coffee", assetClass: "OTHER", baseCurrency: null, quoteCurrency: "USD", digits: 2, tickSize: "0.01", pipSize: "0.01", contractSize: "1", defaultLeverage: 10, fixedPoints: "10" }),
  Object.freeze({ symbol: "COCOA", providerSymbol: "CC1", name: "Cocoa", assetClass: "OTHER", baseCurrency: null, quoteCurrency: "USD", digits: 2, tickSize: "0.01", pipSize: "0.01", contractSize: "1", defaultLeverage: 10, fixedPoints: "10" }),
  Object.freeze({ symbol: "COTTON", providerSymbol: "CT1", name: "Cotton", assetClass: "OTHER", baseCurrency: null, quoteCurrency: "USD", digits: 2, tickSize: "0.01", pipSize: "0.01", contractSize: "1", defaultLeverage: 10, fixedPoints: "10" }),
  Object.freeze({ symbol: "CATTLE", providerSymbol: "LE1", name: "Live Cattle", assetClass: "OTHER", baseCurrency: null, quoteCurrency: "USD", digits: 3, tickSize: "0.001", pipSize: "0.001", contractSize: "1", defaultLeverage: 10, fixedPoints: "10" }),
  Object.freeze({ symbol: "HOGS", providerSymbol: "HE1", name: "Lean Hogs", assetClass: "OTHER", baseCurrency: null, quoteCurrency: "USD", digits: 3, tickSize: "0.001", pipSize: "0.001", contractSize: "1", defaultLeverage: 10, fixedPoints: "10" }),
  Object.freeze({ symbol: "GASOLINE", providerSymbol: "RB1", name: "Gasoline", assetClass: "ENERGY", baseCurrency: null, quoteCurrency: "USD", digits: 4, tickSize: "0.0001", pipSize: "0.0001", contractSize: "1", defaultLeverage: 10, fixedPoints: "10" }),
  Object.freeze({ symbol: "HEATOIL", providerSymbol: "HO1", name: "Heating Oil", assetClass: "ENERGY", baseCurrency: null, quoteCurrency: "USD", digits: 4, tickSize: "0.0001", pipSize: "0.0001", contractSize: "1", defaultLeverage: 10, fixedPoints: "10" }),
  Object.freeze({ symbol: "ALUMINUM", providerSymbol: "ALI1", name: "Aluminum", assetClass: "OTHER", baseCurrency: null, quoteCurrency: "USD", digits: 2, tickSize: "0.01", pipSize: "0.01", contractSize: "1", defaultLeverage: 10, fixedPoints: "10" }),
]);

const INDICES = Object.freeze([
  Object.freeze({ symbol: "US500", providerSymbol: "SPX", name: "S&P 500", currency: "USD" }),
  Object.freeze({ symbol: "US100", providerSymbol: "NDX", name: "Nasdaq 100", currency: "USD" }),
  Object.freeze({ symbol: "US30", providerSymbol: "DJI", name: "Dow Jones Industrial Average", currency: "USD" }),
  Object.freeze({ symbol: "US2000", providerSymbol: "RUT", name: "Russell 2000", currency: "USD" }),
  Object.freeze({ symbol: "VIX", providerSymbol: "VIX", name: "CBOE Volatility Index", currency: "USD" }),
  Object.freeze({ symbol: "UK100", providerSymbol: "FTSE", name: "FTSE 100", currency: "GBP" }),
  Object.freeze({ symbol: "GER40", providerSymbol: "DAX", name: "DAX 40", currency: "EUR" }),
  Object.freeze({ symbol: "FRA40", providerSymbol: "FCHI", name: "CAC 40", currency: "EUR" }),
  Object.freeze({ symbol: "EU50", providerSymbol: "STOXX50E", name: "EURO STOXX 50", currency: "EUR" }),
  Object.freeze({ symbol: "ESP35", providerSymbol: "IBEX", name: "IBEX 35", currency: "EUR" }),
  Object.freeze({ symbol: "IT40", providerSymbol: "FTSEMIB", name: "FTSE MIB", currency: "EUR" }),
  Object.freeze({ symbol: "NETH25", providerSymbol: "AEX", name: "AEX", currency: "EUR" }),
  Object.freeze({ symbol: "SWI20", providerSymbol: "SMI", name: "Swiss Market Index", currency: "CHF" }),
  Object.freeze({ symbol: "JPN225", providerSymbol: "N225", name: "Nikkei 225", currency: "JPY" }),
  Object.freeze({ symbol: "HK50", providerSymbol: "HSI", name: "Hang Seng Index", currency: "HKD" }),
  Object.freeze({ symbol: "CHINA50", providerSymbol: "XIN9", name: "FTSE China A50", currency: "CNY" }),
  Object.freeze({ symbol: "AUS200", providerSymbol: "AXJO", name: "S&P/ASX 200", currency: "AUD" }),
  Object.freeze({ symbol: "INDIA50", providerSymbol: "NSEI", name: "Nifty 50", currency: "INR" }),
  Object.freeze({ symbol: "KOR200", providerSymbol: "KS11", name: "KOSPI Composite", currency: "KRW" }),
  Object.freeze({ symbol: "SG30", providerSymbol: "STI", name: "Straits Times Index", currency: "SGD" }),
]);

const US_EQUITIES = Object.freeze([
  "AAPL",
  "MSFT",
  "NVDA",
  "AMZN",
  "GOOGL",
  "META",
  "TSLA",
  "BRK.B",
  "AVGO",
  "JPM",
  "LLY",
  "WMT",
  "V",
  "ORCL",
  "MA",
  "NFLX",
  "XOM",
  "COST",
  "JNJ",
  "HD",
  "PG",
  "ABBV",
  "BAC",
  "KO",
  "CRM",
  "AMD",
  "CVX",
  "PLTR",
  "PM",
  "CSCO",
  "MCD",
  "IBM",
  "GE",
  "ABT",
  "MRK",
  "PEP",
  "TMO",
  "ACN",
  "LIN",
  "DIS",
  "WFC",
  "AXP",
  "CAT",
  "GS",
  "RTX",
  "VZ",
  "NOW",
  "ISRG",
  "QCOM",
  "UBER",
  "INTU",
  "TXN",
  "AMGN",
  "BKNG",
  "SPGI",
  "PFE",
  "LOW",
  "HON",
  "AMAT",
  "NEE",
  "DHR",
  "UNP",
  "BA",
  "SBUX",
  "COP",
  "DE",
  "MDT",
  "BLK",
  "ADI",
  "PANW",
  "LMT",
  "TJX",
  "GILD",
  "VRTX",
  "ADP",
  "SYK",
  "MMC",
  "CB",
  "UPS",
  "SCHW",
  "MU",
  "C",
  "SO",
  "ICE",
  "MDLZ",
  "ZTS",
  "DUK",
  "REGN",
  "MO",
  "PLD",
  "CL",
  "APO",
  "CVS",
  "CI",
  "BMY",
  "PNC",
  "USB",
  "MCO",
  "SNPS",
  "CDNS",
  "CRWD",
  "MAR",
  "ORLY",
  "MCK",
  "EOG",
  "FDX",
  "AON",
  "ITW",
  "NOC",
  "EMR",
  "GM",
  "F",
  "T",
  "CMCSA",
  "TMUS",
  "PYPL",
  "SHOP",
  "XYZ",
  "COIN",
  "ABNB",
  "DASH",
  "RBLX",
  "SNOW",
  "NET",
  "DDOG",
  "MDB",
  "ZS",
  "OKTA",
  "TEAM",
  "WDAY",
  "ADSK",
  "ANET",
  "DELL",
  "HPQ",
  "INTC",
  "ARM",
  "SMCI",
  "LRCX",
  "KLAC",
  "MRVL",
  "NXPI",
  "ON",
  "MCHP",
  "MPWR",
  "ROKU",
  "SPOT",
  "TTD",
  "PINS",
  "SNAP",
  "NKE",
  "LULU",
  "TGT",
  "DG",
  "DLTR",
  "CROX",
  "CMG",
  "YUM",
  "DPZ",
  "RCL",
  "CCL",
]);

const CRYPTO_PAIRS = Object.freeze([
  "BTC/USD",
  "ETH/USD",
  "SOL/USD",
  "XRP/USD",
  "BNB/USD",
  "ADA/USD",
  "DOGE/USD",
  "AVAX/USD",
  "LINK/USD",
  "DOT/USD",
  "LTC/USD",
  "BCH/USD",
  "XLM/USD",
  "UNI/USD",
  "AAVE/USD",
  "ATOM/USD",
  "TRX/USD",
  "ETC/USD",
  "NEAR/USD",
  "ALGO/USD",
]);

function dynamicSpread(normalPoints, {
  minimumPoints = normalPoints,
  maximumPoints = Math.max(normalPoints * 20, normalPoints),
  rolloverMultiplier = 1,
  rolloverStartUtcMinute = null,
  rolloverEndUtcMinute = null,
  volumeBands = [],
} = {}) {
  return Object.freeze({
    mode: 'DYNAMIC',
    fixedPoints: String(normalPoints),
    markupPoints: '0',
    normalPoints: String(normalPoints),
    minimumPoints: String(minimumPoints),
    maximumPoints: String(maximumPoints),
    rolloverMultiplier: String(rolloverMultiplier),
    rolloverStartUtcMinute,
    rolloverEndUtcMinute,
    volumeBands: Object.freeze(volumeBands.map(item => Object.freeze({ ...item }))),
  });
}

function forexSpreadProfile(pair) {
  const symbol = pair.replace('/', '');
  const [base, quote] = pair.split('/');
  const stressed = FX_STRESSED_CURRENCIES.has(base) || FX_STRESSED_CURRENCIES.has(quote);
  const exotic = FX_EXOTIC_CURRENCIES.has(base) || FX_EXOTIC_CURRENCIES.has(quote);
  const normal = FX_TIGHT_POINTS[symbol] ?? (stressed ? 50 : exotic ? 20 : 6);
  return dynamicSpread(normal, {
    minimumPoints: normal,
    maximumPoints: Math.max(normal * 20, 80),
    rolloverMultiplier: 4,
    rolloverStartUtcMinute: 21 * 60 + 55,
    rolloverEndUtcMinute: 22 * 60 + 10,
    volumeBands: FX_VOLUME_BANDS,
  });
}

function commoditySpreadProfile(spec) {
  const normal = spec.symbol === 'XAUUSD'
    ? 10
    : spec.symbol === 'XAGUSD'
      ? 15
      : spec.assetClass === 'METAL'
        ? 20
        : spec.assetClass === 'ENERGY'
          ? 10
          : Math.max(4, Math.round(Number(spec.fixedPoints || 10) * 0.6));
  return dynamicSpread(normal, {
    minimumPoints: Math.max(1, Math.round(normal * 0.5)),
    maximumPoints: Math.max(normal * 15, 100),
    rolloverMultiplier: ['METAL', 'ENERGY'].includes(spec.assetClass) ? 3 : 1,
    rolloverStartUtcMinute: ['METAL', 'ENERGY'].includes(spec.assetClass) ? 21 * 60 + 55 : null,
    rolloverEndUtcMinute: ['METAL', 'ENERGY'].includes(spec.assetClass) ? 22 * 60 + 10 : null,
    volumeBands: spec.assetClass === 'METAL' ? METAL_VOLUME_BANDS : FX_VOLUME_BANDS,
  });
}

function indexSpreadProfile(spec) {
  const points = { US500: 10, US100: 40, US30: 80, US2000: 40, VIX: 20, UK100: 40, GER40: 40, FRA40: 30, EU50: 25, ESP35: 60, IT40: 60, NETH25: 15, SWI20: 40, JPN225: 400, HK50: 80, CHINA50: 60, AUS200: 30, INDIA50: 50, KOR200: 20, SG30: 15 }[spec.symbol] || 40;
  return dynamicSpread(points, {
    minimumPoints: Math.max(1, Math.round(points * 0.5)),
    maximumPoints: points * 12,
    volumeBands: [
      { upTo: '1', extraPoints: '0' },
      { upTo: '5', extraPoints: String(Math.max(1, Math.round(points * 0.2))) },
      { upTo: '20', extraPoints: String(Math.max(1, Math.round(points * 0.5))) },
      { upTo: '50', extraPoints: String(points) },
      { upTo: null, extraPoints: String(points * 2) },
    ],
  });
}

function equitySpreadProfile() {
  return dynamicSpread(1, {
    minimumPoints: 1,
    maximumPoints: 100,
    volumeBands: [
      { upTo: '10', extraPoints: '0' },
      { upTo: '50', extraPoints: '1' },
      { upTo: '200', extraPoints: '2' },
      { upTo: '1000', extraPoints: '5' },
      { upTo: null, extraPoints: '10' },
    ],
  });
}

function cryptoSpreadProfile(pair) {
  const base = pair.split('/')[0];
  const normal = { BTC: 200, ETH: 20, BNB: 10, BCH: 10 }[base] || 10;
  return dynamicSpread(normal, {
    minimumPoints: Math.max(2, Math.round(normal * 0.5)),
    maximumPoints: normal * 20,
    volumeBands: [
      { upTo: '1', extraPoints: '0' },
      { upTo: '5', extraPoints: String(Math.max(1, Math.round(normal * 0.1))) },
      { upTo: '20', extraPoints: String(Math.max(1, Math.round(normal * 0.25))) },
      { upTo: '50', extraPoints: String(Math.max(1, Math.round(normal * 0.5))) },
      { upTo: null, extraPoints: String(normal) },
    ],
  });
}

function baseSpec({
  symbol, displaySymbol, name, assetClass, baseCurrency = null, quoteCurrency = 'USD',
  digits, tickSize, pipSize, contractSize, minVolume = '0.01', maxVolume = '100',
  volumeStep = '0.01', defaultLeverage = 100, marginRate = null,
  commissionPerLotPerSide = '0', commissionRate = '0', spreadProfile = null,
  fixedPoints = '10', tradingSessions = [],
  timezone = 'UTC', providerSymbol, softQuoteAgeMs = 10000, maxQuoteAgeMs = 30000,
}) {
  const spread = spreadProfile || dynamicSpread(Number(fixedPoints || 0));
  return Object.freeze({
    symbol, displaySymbol, name, assetClass, baseCurrency, quoteCurrency,
    pnlCurrency: quoteCurrency, marginCurrency: quoteCurrency,
    digits, tickSize, pipSize, contractSize, minVolume, maxVolume, volumeStep,
    defaultLeverage: ACG_STANDARD_LEVERAGE, marginRate,
    commissionPerLot: commissionPerLotPerSide,
    commissionPerLotPerSide,
    commissionRate,
    swapLong: '0', swapShort: '0',
    spread,
    tradingSessions, tradingHolidays: Object.freeze([]), timezone,
    providerMappings: Object.freeze({ twelveData: providerSymbol }),
    softQuoteAgeMs, maxQuoteAgeMs, chartEnabled: true, executionEnabled: false, status: 'ACTIVE',
  });
}

function forexSpec(pair) {
  const [baseCurrency, quoteCurrency] = pair.split('/');
  const isJpy = quoteCurrency === 'JPY';
  const exoticQuotes = new Set(['CNH', 'CZK', 'DKK', 'HKD', 'HUF', 'MXN', 'NOK', 'PLN', 'SEK', 'SGD', 'TRY', 'ZAR']);
  return baseSpec({
    symbol: pair.replace('/', ''), displaySymbol: pair,
    name: baseCurrency + ' / ' + quoteCurrency, assetClass: 'FOREX',
    baseCurrency, quoteCurrency, digits: isJpy ? 3 : 5,
    tickSize: isJpy ? '0.001' : '0.00001', pipSize: isJpy ? '0.01' : '0.0001',
    contractSize: '100000', defaultLeverage: 100,
    commissionPerLotPerSide: '2.5',
    spreadProfile: forexSpreadProfile(pair),
    tradingSessions: FX_WEEK, providerSymbol: pair,
    softQuoteAgeMs: exoticQuotes.has(quoteCurrency) ? 10000 : 7000,
    maxQuoteAgeMs: exoticQuotes.has(quoteCurrency) ? 40000 : 25000,
  });
}

function commoditySpec(spec) {
  return baseSpec({
    symbol: spec.symbol,
    displaySymbol: spec.providerSymbol.includes('/') ? spec.providerSymbol : spec.symbol,
    name: spec.name, assetClass: spec.assetClass, baseCurrency: spec.baseCurrency,
    quoteCurrency: spec.quoteCurrency, digits: spec.digits, tickSize: spec.tickSize,
    pipSize: spec.pipSize, contractSize: spec.contractSize,
    defaultLeverage: spec.defaultLeverage,
    commissionPerLotPerSide: spec.assetClass === 'METAL' ? '2.5' : '0',
    spreadProfile: commoditySpreadProfile(spec),
    providerSymbol: spec.providerSymbol, tradingSessions: FX_WEEK,
    softQuoteAgeMs: spec.assetClass === 'OTHER' ? 15000 : 10000,
    maxQuoteAgeMs: spec.assetClass === 'OTHER' ? 60000 : 35000,
  });
}

function indexSpec(spec) {
  return baseSpec({
    symbol: spec.symbol, displaySymbol: spec.symbol, name: spec.name,
    assetClass: 'INDEX', quoteCurrency: spec.currency, digits: 2,
    tickSize: '0.01', pipSize: '0.01', contractSize: '1',
    minVolume: '0.01', maxVolume: '1000', volumeStep: '0.01',
    defaultLeverage: 20,
    spreadProfile: indexSpreadProfile(spec),
    providerSymbol: spec.providerSymbol, tradingSessions: [],
    softQuoteAgeMs: 10000,
    maxQuoteAgeMs: 35000,
  });
}

function equitySpec(symbol) {
  return baseSpec({
    symbol, displaySymbol: symbol, name: symbol + ' US Equity',
    assetClass: 'EQUITY', quoteCurrency: 'USD', digits: 2,
    tickSize: '0.01', pipSize: '0.01', contractSize: '1',
    minVolume: '0.01', maxVolume: '10000', volumeStep: '0.01',
    defaultLeverage: 5,
    spreadProfile: equitySpreadProfile(),
    tradingSessions: US_EQUITY_SESSION, timezone: 'America/New_York',
    providerSymbol: symbol,
    softQuoteAgeMs: 12000,
    maxQuoteAgeMs: 45000,
  });
}

function cryptoSpec(pair) {
  const [baseCurrency, quoteCurrency] = pair.split('/');
  const highPrice = new Set(['BTC', 'ETH', 'BNB', 'BCH']);
  const digits = highPrice.has(baseCurrency) ? 2 : 5;
  return baseSpec({
    symbol: pair.replace('/', ''), displaySymbol: pair,
    name: baseCurrency + ' / ' + quoteCurrency, assetClass: 'CRYPTO',
    baseCurrency, quoteCurrency, digits,
    tickSize: highPrice.has(baseCurrency) ? '0.01' : '0.00001',
    pipSize: highPrice.has(baseCurrency) ? '0.01' : '0.0001',
    contractSize: '1', minVolume: '0.01', maxVolume: '1000',
    volumeStep: '0.01', defaultLeverage: 2,
    commissionRate: '0.0002',
    spreadProfile: cryptoSpreadProfile(pair),
    tradingSessions: [], providerSymbol: pair,
    softQuoteAgeMs: highPrice.has(baseCurrency) ? 10000 : 15000,
    maxQuoteAgeMs: highPrice.has(baseCurrency) ? 35000 : 60000,
  });
}

const ACG_INSTRUMENT_CATALOG = Object.freeze([
  ...FOREX_PAIRS.map(forexSpec),
  ...COMMODITIES.map(commoditySpec),
  ...INDICES.map(indexSpec),
  ...US_EQUITIES.map(equitySpec),
  ...CRYPTO_PAIRS.map(cryptoSpec),
]);

validateCatalog(ACG_INSTRUMENT_CATALOG);

function validateCatalog(catalog) {
  if (catalog.length !== 300) throw new Error('ACG instrument catalog must contain exactly 300 instruments; found ' + catalog.length);
  const symbols = new Set();
  const providerSymbols = new Set();
  for (const item of catalog) {
    if (!item.symbol || symbols.has(item.symbol)) throw new Error('Duplicate or missing ACG instrument symbol: ' + (item.symbol || '(missing)'));
    symbols.add(item.symbol);
    const providerSymbol = item.providerMappings?.twelveData;
    if (!providerSymbol || typeof providerSymbol !== 'string') throw new Error('Twelve Data mapping is required for ' + item.symbol);
    if (providerSymbols.has(providerSymbol)) throw new Error('Duplicate Twelve Data provider symbol: ' + providerSymbol);
    providerSymbols.add(providerSymbol);
  }
}

module.exports = {
  ACG_INSTRUMENT_CATALOG, FX_WEEK, US_EQUITY_SESSION,
  FOREX_PAIRS, COMMODITIES, INDICES, US_EQUITIES, CRYPTO_PAIRS,
  ACG_STANDARD_LEVERAGE,
};
