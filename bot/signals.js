/**
 * SMC v5 — генерация торговых сигналов
 * Точный перевод Pine Script стратегии на JavaScript
 *
 * Паттерн 1: BOS + Order Block pullback
 * Паттерн 2: Liquidity Sweep (двойная/тройная вершина/дно)
 * Фильтры: Kill Zones (UTC) + ADX > 20 + SuperTrend + EMA50 + Volume
 */

import { calcEMA, calcSMA, calcADX, calcSuperTrend } from './indicators.js';

// ══════════ Параметры стратегии (совпадают с Pine Script) ══════════
export const PARAMS = {
  bosLen:    20,    // lookback для BOS и swing high/low
  obBuf:     0.3,   // SL буфер % ниже/выше OB
  rrRatio:   3.0,   // Risk:Reward для TP
  swipeTol:  0.3,   // tolerance % для LiqSwipe
  adxLen:    14,
  adxMin:    20,    // минимальный ADX
  stLen:     10,    // период SuperTrend
  stMult:    3.0,   // множитель SuperTrend
  emaLen:    50,    // период EMA
  volMult:   1.5,   // множитель объёма
  volAvg:    20,    // период для среднего объёма
  maxWaitOB: 15,    // максимум баров ожидания pullback в OB
};

/**
 * Kill Zones: London 07:00–10:00 UTC, New York 13:00–16:00 UTC
 */
export function inKillZone(date = new Date()) {
  const h = date.getUTCHours();
  return (h >= 7 && h < 10) || (h >= 13 && h < 16);
}

/**
 * Максимум из массива за последние n элементов (не включая текущий)
 */
function highest(arr, lookback, i) {
  const from = Math.max(0, i - lookback);
  let max = -Infinity;
  for (let j = from; j < i; j++) {
    if (arr[j] > max) max = arr[j];
  }
  return max;
}

/**
 * Минимум из массива за последние n элементов (не включая текущий)
 */
function lowest(arr, lookback, i) {
  const from = Math.max(0, i - lookback);
  let min = Infinity;
  for (let j = from; j < i; j++) {
    if (arr[j] < min) min = arr[j];
  }
  return min;
}

/**
 * Главная функция анализа свечей.
 *
 * @param {Array} candles  — массив { time, open, high, low, close, volume }
 *                           Должен включать только ЗАКРЫТЫЕ свечи (последняя = только что закрылась)
 * @param {Object} state   — изменяемое состояние символа (pendingLong/Short, obBars и т.д.)
 *                           Передаётся по ссылке, модифицируется внутри
 * @returns {{ signal, debug }}
 *   signal = null | { action:'long'|'short', pattern:'OB'|'Sweep', price, sl, tp }
 */
export function analyzeCandles(candles, state = {}) {
  const n = candles.length;

  // Нужно минимум 60 свечей для надёжного расчёта индикаторов
  if (n < 60) return { signal: null, reason: 'not_enough_candles', count: n };

  const closes  = candles.map(c => c.close);
  const highs   = candles.map(c => c.high);
  const lows    = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  // ── Индикаторы ──
  const ema50Arr  = calcEMA(closes, PARAMS.emaLen);
  const { adx: adxArr } = calcADX(candles, PARAMS.adxLen);
  const { direction: stDirArr } = calcSuperTrend(candles, PARAMS.stLen, PARAMS.stMult);
  const avgVolArr = calcSMA(volumes, PARAMS.volAvg);

  // ── Текущий (последний закрытый) бар ──
  const i = n - 1;
  const c = candles[i];

  const curADX    = adxArr[i];
  const curSTDir  = stDirArr[i];  // -1 = бычий, +1 = медвежий
  const curEMA    = ema50Arr[i];
  const curAvgVol = avgVolArr[i];

  // Если индикаторы ещё не прогрелись — пропускаем
  if (curADX === null || curSTDir === null || curEMA === null || curAvgVol === null) {
    return { signal: null, reason: 'indicators_warming_up' };
  }

  const trendOK  = curADX > PARAMS.adxMin;
  const stBull   = curSTDir < 0;    // SuperTrend бычий
  const stBear   = curSTDir > 0;    // SuperTrend медвежий
  const aboveEMA = c.close > curEMA;
  const belowEMA = c.close < curEMA;
  const volOK    = c.volume > curAvgVol * PARAMS.volMult;
  const kz       = inKillZone(new Date(c.time));

  // ── BOS (Break of Structure) ──
  const prevHigh = highest(highs, PARAMS.bosLen, i);  // highest за последние bosLen баров (без текущего)
  const prevLow  = lowest(lows,   PARAMS.bosLen, i);
  const bosLong  = c.close > prevHigh;
  const bosShort = c.close < prevLow;

  // Базовые фильтры (общие для всех паттернов)
  const baseFilters = trendOK && kz;

  // ══════════ ПАТТЕРН 1 — Order Block ══════════
  // Запоминаем OB при появлении BOS + все фильтры
  if (bosLong && stBull && baseFilters && aboveEMA && volOK && !state.pendingLong && !state.openPosition) {
    state.pendingLong  = true;
    state.obLongHigh   = candles[i - 1].high;   // предыдущая свеча = OB
    state.obLongLow    = candles[i - 1].low;
    state.obLongBar    = i;
  }

  if (bosShort && stBear && baseFilters && belowEMA && volOK && !state.pendingShort && !state.openPosition) {
    state.pendingShort  = true;
    state.obShortHigh   = candles[i - 1].high;
    state.obShortLow    = candles[i - 1].low;
    state.obShortBar    = i;
  }

  // Сброс OB если истёк maxWaitOB
  if (state.pendingLong  && (i - state.obLongBar)  > PARAMS.maxWaitOB) state.pendingLong  = false;
  if (state.pendingShort && (i - state.obShortBar) > PARAMS.maxWaitOB) state.pendingShort = false;

  let signal = null;

  // Вход в Long OB: цена откатилась в зону OB
  if (state.pendingLong && !state.openPosition) {
    if (c.low <= state.obLongHigh && c.close >= state.obLongLow) {
      const sl     = state.obLongLow * (1 - PARAMS.obBuf / 100);
      const slDist = c.close - sl;
      const tp     = c.close + slDist * PARAMS.rrRatio;
      signal = { action: 'long', pattern: 'OB', price: c.close, sl, tp };
      state.pendingLong = false;
    }
  }

  // Вход в Short OB
  if (!signal && state.pendingShort && !state.openPosition) {
    if (c.high >= state.obShortLow && c.close <= state.obShortHigh) {
      const sl     = state.obShortHigh * (1 + PARAMS.obBuf / 100);
      const slDist = sl - c.close;
      const tp     = c.close - slDist * PARAMS.rrRatio;
      signal = { action: 'short', pattern: 'OB', price: c.close, sl, tp };
      state.pendingShort = false;
    }
  }

  // ══════════ ПАТТЕРН 2 — Liquidity Sweep ══════════
  // Свип вверх (медвежий): high пробил swing high, но свеча закрылась ниже
  const swingHigh = highest(highs, PARAMS.bosLen, i);
  const swingLow  = lowest(lows,   PARAMS.bosLen, i);

  const bearSweep = c.high > swingHigh &&
                    c.close < swingHigh * (1 + PARAMS.swipeTol / 100);
  const bullSweep = c.low  < swingLow  &&
                    c.close > swingLow  * (1 - PARAMS.swipeTol / 100);

  if (!signal && bullSweep && stBull && baseFilters && aboveEMA && !state.openPosition) {
    const sl     = c.low * (1 - PARAMS.obBuf / 100);
    const slDist = c.close - sl;
    const tp     = c.close + slDist * PARAMS.rrRatio;
    signal = { action: 'long', pattern: 'Sweep', price: c.close, sl, tp };
  }

  if (!signal && bearSweep && stBear && baseFilters && belowEMA && !state.openPosition) {
    const sl     = c.high * (1 + PARAMS.obBuf / 100);
    const slDist = sl - c.close;
    const tp     = c.close - slDist * PARAMS.rrRatio;
    signal = { action: 'short', pattern: 'Sweep', price: c.close, sl, tp };
  }

  return {
    signal,
    debug: {
      adx:          curADX?.toFixed(1),
      trendOK,
      stDir:        stBull ? '▲ Bull' : '▼ Bear',
      ema:          curEMA?.toFixed(5),
      aboveEMA,
      volOK,
      kz,
      bosLong,
      bosShort,
      bullSweep,
      bearSweep,
      pendingLong:  !!state.pendingLong,
      pendingShort: !!state.pendingShort,
    },
  };
}
