/**
 * Markov Regime Model — фильтр макро-состояния рынка
 *
 * Основан на "Hedge Fund Method" (Rowan Chain):
 *   1. Каждый день маркируется состоянием: bull / sideways / bear
 *      на основе 20-дневного накопленного возврата
 *   2. Строится матрица переходов 3×3 по всей истории
 *   3. Сигнал = P(bull завтра) − P(bear завтра) для текущего состояния
 *      > 0 = бычий режим, < 0 = медвежий режим
 *
 * Использование в стратегии:
 *   signal > +0.15 → предпочитать лонги, избегать шортов
 *   signal < -0.15 → предпочитать шорты, избегать лонгов
 *   |signal| < 0.15 → нейтральный режим, торгуем осторожно
 */

export const MARKOV_PARAMS = {
  statePeriod:   20,    // дней для расчёта накопленного возврата
  bullThresh:    0.05,  // +5% за 20 дней = bull
  bearThresh:   -0.05,  // -5% за 20 дней = bear
  minHistory:    60,    // минимум дневных свечей для надёжной матрицы
  filterThresh:  0.15,  // |signal| ниже порога — фильтр не применяется
};

// ── Шаг 1: Маркировка состояний ──────────────────────────────────────────────
function labelAllStates(closes, params = MARKOV_PARAMS) {
  const states = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < params.statePeriod) {
      states.push('sideways'); // прогрев — нейтральная метка
      continue;
    }
    const ret = (closes[i] - closes[i - params.statePeriod]) / closes[i - params.statePeriod];
    if (ret >= params.bullThresh)      states.push('bull');
    else if (ret <= params.bearThresh) states.push('bear');
    else                               states.push('sideways');
  }
  return states;
}

// ── Шаг 2: Матрица переходов ─────────────────────────────────────────────────
function buildTransitionMatrix(states) {
  const KEYS = ['bull', 'sideways', 'bear'];

  // Инициализируем счётчики
  const counts = {};
  for (const k of KEYS) {
    counts[k] = { bull: 0, sideways: 0, bear: 0, total: 0 };
  }

  // Считаем переходы
  for (let i = 1; i < states.length; i++) {
    const from = states[i - 1];
    const to   = states[i];
    if (!from || !to) continue;
    counts[from][to]++;
    counts[from].total++;
  }

  // Нормализуем в вероятности
  const matrix = {};
  for (const from of KEYS) {
    matrix[from] = {};
    const total = counts[from].total || 1; // защита от деления на 0
    for (const to of KEYS) {
      matrix[from][to] = counts[from][to] / total;
    }
    // Если состояние никогда не встречалось — равномерное распределение
    if (counts[from].total === 0) {
      matrix[from] = { bull: 1/3, sideways: 1/3, bear: 1/3 };
    }
  }
  return matrix;
}

// ── Главная функция ───────────────────────────────────────────────────────────

/**
 * Анализирует дневные свечи и возвращает Markov-сигнал.
 *
 * @param {Array} dailyCandles  — массив { time, open, high, low, close, volume }
 * @param {Object} params       — параметры (опционально)
 * @returns {{
 *   signal: number,      // bullProb - bearProb, от -1 до +1
 *   state: string,       // текущее состояние: 'bull' | 'sideways' | 'bear'
 *   bullProb: number,    // вероятность bull завтра
 *   bearProb: number,    // вероятность bear завтра
 *   sideProb: number,    // вероятность sideways завтра
 *   matrix: object,      // полная матрица переходов (для отладки)
 * }}
 */
export function analyzeMarkov(dailyCandles, params = MARKOV_PARAMS) {
  if (!dailyCandles || dailyCandles.length < params.minHistory) {
    return {
      signal: 0, state: 'unknown',
      bullProb: 0, bearProb: 0, sideProb: 0,
      reason: `мало дневных свечей: ${dailyCandles?.length ?? 0}`,
    };
  }

  const closes = dailyCandles.map(c => c.close);
  const states = labelAllStates(closes, params);
  const matrix = buildTransitionMatrix(states);

  // Текущее состояние = последнее
  const currentState = states[states.length - 1];

  const row      = matrix[currentState];
  const bullProb = row.bull;
  const bearProb = row.bear;
  const sideProb = row.sideways;
  const signal   = bullProb - bearProb;  // >0 = бычий, <0 = медвежий

  return { signal, state: currentState, bullProb, bearProb, sideProb, matrix };
}

/**
 * Красивый вывод состояния для логов.
 * Пример: "BULL +34%" или "BEAR -22%" или "SIDE +3%"
 */
export function markovLabel(markov) {
  if (!markov || markov.state === 'unknown') return '?MKV';
  const pct  = (markov.signal * 100).toFixed(0);
  const sign = markov.signal >= 0 ? '+' : '';
  return `${markov.state.toUpperCase().slice(0, 4)}${sign}${pct}%`;
}
