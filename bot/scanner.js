/**
 * SMC Scanner — автономный сканер без TradingView
 *
 * Запускается вместе с сервером, каждые 15 минут (при закрытии свечи):
 *   1. Скачивает последние 100 свечей с Bybit
 *   2. Запускает SMC сигнальную логику для каждого символа
 *   3. Открывает позицию если есть сигнал
 *   4. Логирует сделку в Notion
 */

import { analyzeCandles, inKillZone }                          from './signals.js';
import { openPosition, getPositions,
         fetchPublicOHLCV, fetchPublicDailyOHLCV }             from './bybit.js';
import { logTradeOpen }                                        from './notion.js';
import { analyzeMarkov, markovLabel, MARKOV_PARAMS }           from './markov.js';

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

// ══════════ Загрузка 15-минутных свечей ══════════
async function fetchClosedCandles(symbol, limit = 110) {
  const candles = await fetchPublicOHLCV(symbol, limit);
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

    // ── Markov Regime Model (дневной макро-фильтр) ──────────────────────────
    let markov = null;
    try {
      const dailyCandles = await fetchPublicDailyOHLCV(symbol, 220);
      if (dailyCandles.length >= MARKOV_PARAMS.minHistory) {
        markov = analyzeMarkov(dailyCandles);
      }
    } catch (e) {
      console.log(`[Scanner] ⚠️  Markov: ${e.message.slice(0, 60)}`);
    }

    // ── Открытые позиции (fail-safe) ────────────────────────────────────────
    let positions = [];
    try {
      positions = await getPositions();
    } catch (e) {
      console.log(`[Scanner] ⚠️  getPositions недоступен: ${e.message.slice(0, 60)}`);
    }
    const hasPosition = positions.some(p => p.symbol === symbol);
    state.openPosition = hasPosition;

    // ── SMC анализ 15-минутных свечей ────────────────────────────────────────
    const { signal, debug, reason } = analyzeCandles(candles, state);

    // ── Лог состояния ────────────────────────────────────────────────────────
    const kzMark  = debug?.kz       ? '🟢KZ' : '⚫KZ';
    const adxMark = debug?.trendOK  ? `🟢ADX${debug.adx}` : `🔴ADX${debug.adx}`;
    const stMark  = debug?.stDir    || '?';
    const emaMark = debug?.aboveEMA ? '↑EMA' : '↓EMA';
    const volMark = debug?.volOK    ? '🟢Vol' : '🔴Vol';
    const mkvMark = markov          ? markovLabel(markov) : '?MKV';
    const posMark = hasPosition     ? '📌POS' : '';

    console.log(`[Scanner] ${symbol.split('/')[0].padEnd(5)} | ${kzMark} ${adxMark} ${stMark} ${emaMark} ${volMark} | ${mkvMark} ${posMark}`.trimEnd());

    if (!signal) {
      log.reason = reason || 'нет сигнала';
      return log;
    }

    log.signal = signal;

    // ── Markov фильтр сигнала ────────────────────────────────────────────────
    if (markov && Math.abs(markov.signal) >= MARKOV_PARAMS.filterThresh) {
      if (signal.action === 'long' && markov.signal < -MARKOV_PARAMS.filterThresh) {
        const reason = `Markov медвежий режим: ${mkvMark} (${(markov.bullProb*100).toFixed(0)}% bull vs ${(markov.bearProb*100).toFixed(0)}% bear)`;
        log.reason = reason;
        console.log(`[Scanner] 🚫 ${symbol.split('/')[0]} LONG заблокирован — ${reason}`);
        return log;
      }
      if (signal.action === 'short' && markov.signal > MARKOV_PARAMS.filterThresh) {
        const reason = `Markov бычий режим: ${mkvMark} (${(markov.bullProb*100).toFixed(0)}% bull vs ${(markov.bearProb*100).toFixed(0)}% bear)`;
        log.reason = reason;
        console.log(`[Scanner] 🚫 ${symbol.split('/')[0]} SHORT заблокирован — ${reason}`);
        return log;
      }
    }

    // Проверяем лимит позиций
    const maxPos = parseInt(process.env.MAX_POSITIONS ?? '2');
    if (positions.length >= maxPos) {
      log.reason = `лимит позиций ${positions.length}/${maxPos}`;
      console.log(`[Scanner] ⚠️  ${symbol} — лимит позиций, пропускаем`);
      return log;
    }

    // Открываем позицию (fail-safe: если API недоступно — логируем сигнал без ордера)
    const side = signal.action === 'long' ? 'buy' : 'sell';
    console.log(`[Scanner] 🚨 СИГНАЛ ${signal.action.toUpperCase()} ${symbol} | ${signal.pattern} | SL:${signal.sl?.toFixed(5)} TP:${signal.tp?.toFixed(5)}`);

    let result = null;
    try {
      result = await openPosition({ symbol, side, sl: signal.sl, tp: signal.tp });
      tradeCounter++;
      console.log(`[Scanner] ✅ Открыто #${tradeCounter}: ${result.amount} @ ${result.price}`);
    } catch (e) {
      console.log(`[Scanner] ⚠️  Торговый API недоступен (${e.message.slice(0, 60)}) — сигнал залогирован без ордера`);
      log.opened = { action: signal.action, pattern: signal.pattern, price: signal.price, dryRun: true };
    }

    if (result) {
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
    }

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
