/**
 * Технические индикаторы — точный перевод Pine Script логики
 * EMA, SMA, ATR, ADX/DMI, SuperTrend
 */

/**
 * EMA — экспоненциальная скользящая средняя
 * Идентично ta.ema() в Pine Script
 */
export function calcEMA(values, period) {
  const k = 2 / (period + 1);
  const result = [];
  let ema = null;
  for (let i = 0; i < values.length; i++) {
    if (ema === null) {
      ema = values[i];
    } else {
      ema = values[i] * k + ema * (1 - k);
    }
    result.push(ema);
  }
  return result;
}

/**
 * SMA — простая скользящая средняя
 */
export function calcSMA(values, period) {
  return values.map((_, i) => {
    if (i < period - 1) return null;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    return sum / period;
  });
}

/**
 * ATR — Average True Range (сглаживание Уайлдера)
 * Идентично ta.atr() в Pine Script
 */
export function calcATR(candles, period) {
  const n = candles.length;
  const trs = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prev = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  });

  const atr = new Array(n).fill(null);
  if (n < period) return atr;

  // Первый ATR = среднее арифметическое первых `period` TR
  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i];
  atr[period - 1] = sum / period;

  // Далее — сглаживание Уайлдера
  for (let i = period; i < n; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + trs[i]) / period;
  }
  return atr;
}

/**
 * ADX / DMI — индекс направленного движения (Уайлдер)
 * Идентично ta.dmi() в Pine Script
 * Возвращает { adx[], diPlus[], diMinus[] }
 */
export function calcADX(candles, period) {
  const n = candles.length;
  const adx    = new Array(n).fill(null);
  const diPlus  = new Array(n).fill(null);
  const diMinus = new Array(n).fill(null);

  if (n < period * 2) return { adx, diPlus, diMinus };

  // Вычисляем +DM, -DM и TR для каждой свечи
  const dmP = [0], dmM = [0], trs = [candles[0].high - candles[0].low];
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    const up   = c.high - p.high;
    const down = p.low  - c.low;
    dmP.push(up > down && up > 0 ? up : 0);
    dmM.push(down > up && down > 0 ? down : 0);
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }

  // Сглаживание Уайлдера (cumulative)
  function wilderSmooth(arr) {
    const res = new Array(n).fill(null);
    let s = 0;
    for (let i = 0; i < period; i++) s += arr[i];
    res[period - 1] = s;
    for (let i = period; i < n; i++) {
      res[i] = res[i - 1] - res[i - 1] / period + arr[i];
    }
    return res;
  }

  const sTR  = wilderSmooth(trs);
  const sDMP = wilderSmooth(dmP);
  const sDMM = wilderSmooth(dmM);

  // DI+ и DI-
  const dx = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    if (!sTR[i]) continue;
    diPlus[i]  = 100 * sDMP[i] / sTR[i];
    diMinus[i] = 100 * sDMM[i] / sTR[i];
    const s = diPlus[i] + diMinus[i];
    if (s > 0) dx[i] = 100 * Math.abs(diPlus[i] - diMinus[i]) / s;
  }

  // ADX = сглаживание Уайлдера от DX
  let dxCount = 0, dxSum = 0, adxStart = -1;
  for (let i = period - 1; i < n; i++) {
    if (dx[i] === null) continue;
    dxSum += dx[i];
    dxCount++;
    if (dxCount === period) { adx[i] = dxSum / period; adxStart = i; break; }
  }
  if (adxStart >= 0) {
    for (let i = adxStart + 1; i < n; i++) {
      if (dx[i] !== null && adx[i - 1] !== null) {
        adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
      }
    }
  }

  return { adx, diPlus, diMinus };
}

/**
 * SuperTrend
 * Идентично ta.supertrend(multiplier, period) в Pine Script
 * Возвращает { line[], direction[] }
 * direction: -1 = бычий (цена выше), +1 = медвежий (цена ниже)
 */
export function calcSuperTrend(candles, period, multiplier) {
  const n = candles.length;
  const atrVals = calcATR(candles, period);
  const line = new Array(n).fill(null);
  const direction = new Array(n).fill(null);

  let prevUpper = null, prevLower = null, prevDir = null;

  for (let i = 0; i < n; i++) {
    if (atrVals[i] === null) continue;

    const hl2 = (candles[i].high + candles[i].low) / 2;
    const basicUpper = hl2 + multiplier * atrVals[i];
    const basicLower = hl2 - multiplier * atrVals[i];

    // Final bands (не опускаем верхнюю и не поднимаем нижнюю)
    const prevClose = i > 0 ? candles[i - 1].close : candles[i].close;
    const finalUpper = (prevUpper === null || basicUpper < prevUpper || prevClose > prevUpper)
      ? basicUpper : prevUpper;
    const finalLower = (prevLower === null || basicLower > prevLower || prevClose < prevLower)
      ? basicLower : prevLower;

    // Направление
    let d;
    if (prevDir === null) {
      d = 1;
    } else if (prevDir === 1) {
      d = candles[i].close > finalUpper ? -1 : 1;
    } else {
      d = candles[i].close < finalLower ? 1 : -1;
    }

    line[i] = d === -1 ? finalLower : finalUpper;
    direction[i] = d;

    prevUpper = finalUpper;
    prevLower = finalLower;
    prevDir = d;
  }

  return { line, direction };
}
