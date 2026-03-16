const WebSocket = require("ws");
const TelegramBot = require("node-telegram-bot-api");
const https = require("https");

// =======================
// Telegram
// =======================
// تم وضع التوكن الخاص بك هنا
const TOKEN = "8721367618:AAG13HT49nNzYRM3oNlyHDnUpJoA6aIHQPI";
const CHAT_ID = "1914749683";
const bot = new TelegramBot(TOKEN);

// =======================
// Binance Market-Data Only
// =======================
const WS_BASE = "wss://data-stream.binance.vision/stream?streams=";
const REST_BASE = "https://data-api.binance.vision/api/v3/klines";

// =======================
// Settings
// =======================
const ENTRY_INTERVAL = "5m";
const TREND_INTERVAL = "4h";

const EMA_PERIOD = 200;
const LOOKBACK = 12;
const MAX_CANDLES = 300;

const TP1_RR = 1;
const TP2_RR = 2;

// =======================
// Symbols
// =======================
const symbols = [
  "BTCUSDT","ETHUSDT","BNBUSDT","XRPUSDT","SOLUSDT","ADAUSDT","DOGEUSDT","TRXUSDT",
  "AVAXUSDT","DOTUSDT","MATICUSDT","LINKUSDT","ATOMUSDT","LTCUSDT","ETCUSDT","XLMUSDT",
  "FILUSDT","APTUSDT","NEARUSDT","OPUSDT","ARBUSDT","INJUSDT","RNDRUSDT","DYDXUSDT",
  "SUIUSDT","SEIUSDT","TIAUSDT","STXUSDT","CFXUSDT","KAVAUSDT","FTMUSDT","ALGOUSDT",

  "EOSUSDT","AAVEUSDT","UNIUSDT","COMPUSDT","CRVUSDT","SNXUSDT","RUNEUSDT","GMXUSDT",
  "PEPEUSDT","WLDUSDT","FLOKIUSDT","BONKUSDT","PYTHUSDT","JUPUSDT","ORDIUSDT",
  "SANDUSDT","APEUSDT","GALAUSDT","CHZUSDT","ENJUSDT","BATUSDT","ZILUSDT",

  "DASHUSDT","ZECUSDT","KSMUSDT","YFIUSDT","BCHUSDT","LDOUSDT","SUSHIUSDT","1INCHUSDT",
  "ANKRUSDT","CELRUSDT","HOTUSDT","ICXUSDT","ONTUSDT","IOSTUSDT","STORJUSDT","SKLUSDT",
  "BANDUSDT","WAVESUSDT","ZENUSDT","FLMUSDT","RSRUSDT","REEFUSDT","ALPHAUSDT","CTSIUSDT",

  "ARPAUSDT","MTLUSDT","LRCUSDT","COTIUSDT","TLMUSDT","AUDIOUSDT","OCEANUSDT",
  "NKNUSDT","STMXUSDT","BELUSDT","HIVEUSDT","DENTUSDT","MASKUSDT",
  "HOOKUSDT","MAGICUSDT","ASTRUSDT","PHBUSDT","IDUSDT","LQTYUSDT"
];

// =======================
// Storage
// =======================
const candles5m = new Map();
const candles4h = new Map();
const sentSignals = new Set();

// =======================
// Helpers
// =======================
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function calculateEMA(prices, period) {
  if (!prices || prices.length < period) return null;

  const k = 2 / (period + 1);
  let ema = prices[0];

  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }

  return ema;
}

function formatPrice(price) {
  if (!Number.isFinite(price)) return "N/A";
  if (price >= 1000) return price.toFixed(2);
  if (price >= 100) return price.toFixed(3);
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.01) return price.toFixed(6);
  return price.toFixed(8);
}

function buildWsUrl() {
  const streams = [];

  for (const s of symbols) {
    streams.push(`${s.toLowerCase()}@kline_${ENTRY_INTERVAL}`);
    streams.push(`${s.toLowerCase()}@kline_${TREND_INTERVAL}`);
  }

  return WS_BASE + streams.join("/");
}

function pushCandle(map, symbol, candle) {
  if (!map.has(symbol)) map.set(symbol, []);

  const arr = map.get(symbol);
  const last = arr[arr.length - 1];

  if (last && last.openTime === candle.openTime) {
    arr[arr.length - 1] = candle;
  } else {
    arr.push(candle);
  }

  if (arr.length > MAX_CANDLES) {
    arr.shift();
  }
}

function parseRestKline(k) {
  return {
    openTime: Number(k[0]),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
  };
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0"
        }
      },
      (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch (err) {
            reject(new Error(`Invalid JSON response: ${data.slice(0, 300)}`));
          }
        });
      }
    );

    req.on("error", (err) => {
      reject(err);
    });

    req.setTimeout(15000, () => {
      req.destroy(new Error("Request timeout"));
    });
  });
}

async function fetchKlines(symbol, interval, limit) {
  const url = `${REST_BASE}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const data = await httpGetJson(url);

  if (!Array.isArray(data)) {
    console.log(`[BINANCE NON-ARRAY] ${symbol} ${interval}:`, data);
    return [];
  }

  return data.map(parseRestKline);
}

// =======================
// Historical preload
// =======================
async function preloadSymbol(symbol) {
  try {
    const entryData = await fetchKlines(symbol, ENTRY_INTERVAL, MAX_CANDLES);
    await sleep(120);
    const trendData = await fetchKlines(symbol, TREND_INTERVAL, MAX_CANDLES);

    if (entryData.length > 0) candles5m.set(symbol, entryData);
    if (trendData.length > 0) candles4h.set(symbol, trendData);

    console.log(`[PRELOAD OK] ${symbol} | 5m=${entryData.length} | 4h=${trendData.length}`);
  } catch (e) {
    console.log(`[PRELOAD ERROR] ${symbol}: ${e.message}`);
  }
}

async function preloadAll() {
  console.log("🚀 Starting data preload...");

  for (const symbol of symbols) {
    await preloadSymbol(symbol);
    await sleep(120);
  }

  console.log("✅ Preload completed.");
}

// =======================
// Trend
// =======================
function getTrend(symbol) {
  const arr = candles4h.get(symbol);
  if (!arr || arr.length < EMA_PERIOD) return null;

  const closes = arr.map((c) => c.close);
  const ema = calculateEMA(closes, EMA_PERIOD);
  if (ema === null) return null;

  const lastClose = closes[closes.length - 1];

  return {
    bull: lastClose > ema,
    bear: lastClose < ema,
    ema,
    lastClose
  };
}

// =======================
// Strategy
// =======================
function checkSignal(symbol) {
  const trend = getTrend(symbol);
  if (!trend) return;

  const arr = candles5m.get(symbol);
  if (!arr || arr.length < LOOKBACK + 2) return;

  const last = arr[arr.length - 1];
  const prev = arr[arr.length - 2];

  const recent = arr.slice(-(LOOKBACK + 1), -1);
  if (recent.length < LOOKBACK) return;

  const prevHigh = Math.max(...recent.map((c) => c.high));
  const prevLow = Math.min(...recent.map((c) => c.low));

  const bearishEngulf =
    last.close < last.open &&
    prev.close > prev.open &&
    last.open >= prev.close &&
    last.close <= prev.open;

  const bullishEngulf =
    last.close > last.open &&
    prev.close < prev.open &&
    last.open <= prev.close &&
    last.close >= prev.open;

  const bearishReject =
    last.close < last.open &&
    (last.high - Math.max(last.open, last.close)) >
      Math.abs(last.close - last.open) * 1.2;

  const bullishReject =
    last.close > last.open &&
    (Math.min(last.open, last.close) - last.low) >
      Math.abs(last.close - last.open) * 1.2;

  const bearishPattern = bearishEngulf || bearishReject;
  const bullishPattern = bullishEngulf || bullishReject;

  const sweepHigh =
    last.high > prevHigh &&
    last.close < prevHigh;

  const sweepLow =
    last.low < prevLow &&
    last.close > prevLow;

  if (trend.bear && sweepHigh && bearishPattern) {
    sendSignal("SELL", symbol, last);
  }

  if (trend.bull && sweepLow && bullishPattern) {
    sendSignal("BUY", symbol, last);
  }
}

// =======================
// Send Signal
// =======================
async function sendSignal(side, symbol, candle) {
  const key = `${symbol}_${candle.openTime}_${side}`;
  if (sentSignals.has(key)) return;

  const entry = candle.close;
  const stop = side === "BUY" ? candle.low : candle.high;
  const risk = Math.abs(entry - stop);

  if (risk <= 0) return;

  const tp1 =
    side === "BUY"
      ? entry + risk * TP1_RR
      : entry - risk * TP1_RR;

  const tp2 =
    side === "BUY"
      ? entry + risk * TP2_RR
      : entry - risk * TP2_RR;

  const message = `🚨 ${side} SIGNAL

Symbol: ${symbol}
Entry: ${formatPrice(entry)}
SL: ${formatPrice(stop)}
TP1: ${formatPrice(tp1)}
TP2: ${formatPrice(tp2)}

TF: ${ENTRY_INTERVAL}
Trend TF: ${TREND_INTERVAL}
Strategy: Liquidity Sweep + Engulfing`;

  try {
    await bot.sendMessage(CHAT_ID, message);
    sentSignals.add(key);
    console.log(`[SIGNAL] ${symbol} ${side}`);
  } catch (e) {
    console.log("Telegram error:", e.message);
  }
}

// =======================
// WebSocket
// =======================
function startWS() {
  const ws = new WebSocket(buildWsUrl());

  ws.on("open", async () => {
    console.log("BOT STARTED");
    try {
      await bot.sendMessage(CHAT_ID, "✅ Sweep Bot Started");
    } catch (e) {
      console.log("Telegram start error:", e.message);
    }
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (!msg.data || !msg.data.k) return;

      const k = msg.data.k;
      if (!k.x) return;

      const candle = {
        openTime: k.t,
        open: parseFloat(k.o),
        high: parseFloat(k.h),
        low: parseFloat(k.l),
        close: parseFloat(k.c)
      };

      const symbol = k.s;

      if (msg.stream.includes("@kline_5m")) {
        pushCandle(candles5m, symbol, candle);
        checkSignal(symbol);
      }

      if (msg.stream.includes("@kline_4h")) {
        pushCandle(candles4h, symbol, candle);
      }
    } catch (e) {
      console.log("Parse error:", e.message);
    }
  });

  ws.on("close", () => {
    console.log("WS CLOSED - RECONNECTING");
    setTimeout(startWS, 5000);
  });

  ws.on("error", (err) => {
    console.log("WS ERROR:", err.message);
  });
}

// =======================
// Start
// =======================
(async () => {
  await preloadAll();
  startWS();
})();
