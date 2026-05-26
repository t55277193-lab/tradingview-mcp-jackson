/**
 * SMC Scanner — автономный сканер без TradingView
 *
 * Запускается вместе с сервером, каждые 15 минут (при закрытии свечи):
 *   1. Скачивает последние 100 свечей с Bybit
 *   2. Запускает SMC сигнальную логику для каждого символа
 *   3. Открывает позицию если есть сигнал
 *   4. Логирует сделку в Notion
 */

import { analyzeCandles, inKillZone } from './signals.js';
import { openPosition, getPositions, fetchPublicOHLCV } from './bybit.js';
import { logTradeOpen }                from './notion.js';

// ══════════ Символы для торговли ══════════
const SYMBOLS = [
  'SOL/USDT:USDT',
  'SUI/USDT:USDT',
  'DOGE/USDT:USDT',
  'NEAR/USDT:USDT',
];

// ══════════ Состояние сканера ══════════
const symbolStates = {};       // OB pending state на символ
let tradeCounter   = 0;
export const notionPages = {}; // symbol → notionPageId (для закрытия)
export const scanLog     = []; // последние 50 циклов

function getState(symbol) {
  if (!symbolStates[symbol]) symbolStates[symbol] = {};
  return symbolStates[symbol];
}

// ══════════ Загрузка свечей с Bybit (прямой HTTP) ══════════
async function fetchClosedCandles(symbol, limit = 110) {
  const candles = await fetchPublicOHLCV(symbol, '15', limit);
  // Убираем последнюю свечу — она ещё не закрыта
  return candles.slice(0, -1);
}

// ══════════ Сканирование одного символа ══════════
async function scanSymbol(symbol) {
  const state = getState(symbol);
  const log   = { symbol, ts: new Date().toISOString(), signal: null, reason: null, error: null };

  try {
    // Загружаем свечи напрямую через HTTP (без CCXT, без loadMarkets)
    const candles = await fetchClosedCandles(symbol);
    if (candles.length < 60) {
      log.reason = `мало свечей: ${candles.length}`;
      return log;
    }

    // Проверяем открытые позиции по этому символу
    const positions   = await getPositions();
    const hasPosition = positions.some(p => p.symbol === symbol);
    state.openPosition = hasPosition;

    // Анализ
    const { signal, debug, reason } = analyzeCandles(candles, state);

    // Красивый лог состояния
    const lastCandle = candles[candles.length - 1];
    const kzMark  = debug?.kz       ? '🟢KZ' : '⚫KZ';
    const adxMark = debug?.trendOK  ? `🟢ADX${debug.adx}` : `🔴ADX${debug.adx}`;
    const stMark  = debug?.stDir    || '?';
    const emaMark = debug?.aboveEMA ? '↑EMA' : '↓EMA';
    const volMark = debug?.volOK    ? '🟢Vol' : '🔴Vol';
    const posMark = hasPosition     ? '📌POS' : '';

    console.log(`[Scanner] ${symbol.split('/')[0].padEnd(5)} | ${kzMark} ${adxMark} ${stMark} ${emaMark} ${volMark} ${posMark}`.trimEnd());

    if (!signal) {
      log.reason = reason || 'нет сигнала';
      return log;
    }

    log.signal = signal;

    // Проверяем лимит позиций
    const maxPos = parseInt(process.env.MAX_POSITIONS ?? '2');
    if (positions.length >= maxPos) {
      log.reason = `лимит позиций ${positions.length}/${maxPos}`;
      console.log(`[Scanner] ⚠️  ${symbol} — лимит позиций, пропускаем`);
      return log;
    }

    // Открываем позицию
    const side = signal.action === 'long' ? 'buy' : 'sell';
    console.log(`[Scanner] 🚨 СИГНАЛ ${signal.action.toUpperCase()} ${symbol} | ${signal.pattern} | SL:${signal.sl?.toFixed(5)} TP:${signal.tp?.toFixed(5)}`);

    const result = await openPosition({ symbol, side, sl: signal.sl, tp: signal.tp });
    tradeCounter++;

    console.log(`[Scanner] ✅ Открыто #${tradeCounter}: ${result.amount} @ ${result.price}`);

    // Логируем в Notion
    const pageId = await logTradeOpen({
      symbol,
      action:   signal.action,
      price:    result.price,
      sl:       signal.sl,
      tp:       signal.tp,
      amount:   result.amount,
      tradeNum: tradeCounter,
      pattern:  signal.pattern,
    });
    if (pageId) notionPages[symbol] = pageId;

    log.opened = { action: signal.action, pattern: signal.pattern, price: result.price };

  } catch (err) {
    log.error = err.message;
    console.error(`[Scanner] ❌ ${symbol}: ${err.message}`);
  }

  return log;
}

// ══════════ Один цикл сканирования ══════════
async function runScanCycle() {
  const ts = new Date().toISOString();
  console.log(`\n[Scanner] ━━━ Цикл ${ts} ━━━`);

  const results = [];
  for (const symbol of SYMBOLS) {
    const r = await scanSymbol(symbol);
    results.push(r);
    // Небольшая пауза между запросами чтобы не бить rate limit
    await new Promise(res => setTimeout(res, 800));
  }

  scanLog.push({ ts, results });
  if (scanLog.length > 50) scanLog.shift();
}

// ══════════ Планировщик (каждые 15 минут по закрытию свечи) ══════════
let scannerActive = false;
let scannerTimer  = null;

function scheduleNextScan() {
  const now      = Date.now();
  const interval = 15 * 60 * 1000;  // 15 минут в мс
  // Следующая 15-минутная отметка + 5 секунд (буфер для закрытия свечи)
  const nextMark  = Math.ceil(now / interval) * interval + 5_000;
  const delay     = nextMark - now;
  const nextTime  = new Date(nextMark).toISOString().slice(11, 19);

  console.log(`[Scanner] ⏰ Следующий скан в ${nextTime} UTC (через ${Math.round(delay / 1000)}с)`);

  scannerTimer = setTimeout(async () => {
    if (!scannerActive) return;
    try {
      await runScanCycle();
    } catch (err) {
      console.error('[Scanner] Ошибка цикла:', err.message);
    }
    scheduleNextScan();  // планируем следующий
  }, delay);
}

// ══════════ Публичный API ══════════

/** Запустить сканер при старте сервера */
export function startScanner() {
  if (scannerActive) return;
  scannerActive = true;
  console.log('[Scanner] 🚀 Автономный сканер запущен');
  console.log('[Scanner] 📊 Символы:', SYMBOLS.join(', '));

  // Запускаем первый скан сразу (без ожидания закрытия свечи)
  runScanCycle().catch(err => console.error('[Scanner] Первый скан:', err.message));

  // Планируем циклические сканы по закрытию свечей
  scheduleNextScan();
}

/** Остановить сканер */
export function stopScanner() {
  scannerActive = false;
  if (scannerTimer) { clearTimeout(scannerTimer); scannerTimer = null; }
  console.log('[Scanner] Сканер остановлен');
}

/** Получить статус для /status эндпоинта */
export function getScannerStatus() {
  return {
    active:       scannerActive,
    tradeCounter,
    symbols:      SYMBOLS,
    symbolStates: Object.fromEntries(
      Object.entries(symbolStates).map(([k, v]) => [k, {
        pendingLong:  !!v.pendingLong,
        pendingShort: !!v.pendingShort,
        openPosition: !!v.openPosition,
      }])
    ),
    recentScans: scanLog.slice(-5),
  };
}
