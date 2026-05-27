import ccxt from 'ccxt';
import https from 'https';

/**
 * Bybit Futures клиент
 * Поддерживает USDT-маржинальные perpetual контракты
 */

let exchange = null;

/**
 * Прямой HTTP-запрос к Bybit v5 публичному API (без CCXT).
 * CCXT при инициализации загружает спотовые рынки (category=spot),
 * которые заблокированы CloudFront на некоторых Railway IP.
 * Этот метод минует loadMarkets() и идёт напрямую на kline endpoint.
 *
 * @param {string} symbol  - ccxt формат: 'SOL/USDT:USDT'
 * @param {string} interval - '1','5','15','60','240','D'
 * @param {number} limit   - кол-во свечей (макс 200)
 * @returns {Promise<Array>} массив { time, open, high, low, close, volume }
 */
/**
 * Универсальная загрузка OHLCV: Bybit → фолбэк на Binance Futures
 * Оба источника публичные, без аутентификации.
 * Binance Futures доступен с Railway US-West IP без блокировок.
 */
/**
 * 15-минутные свечи: Bybit → Binance → Gate.io
 * interval для каждой биржи:  Bybit='15', Binance='15m', Gate.io='15m'
 */
export async function fetchPublicOHLCV(symbol, limit = 110) {
  try {
    return await _fetchBybitKlines(symbol, '15', limit);
  } catch (e) {
    console.log(`[OHLCV] Bybit: ${e.message.slice(0, 80)}`);
  }
  try {
    const r = await _fetchBinanceKlines(symbol, '15m', limit);
    console.log(`[OHLCV] Binance ✅`);
    return r;
  } catch (e) {
    console.log(`[OHLCV] Binance: ${e.message.slice(0, 80)}`);
  }
  console.log(`[OHLCV] Gate.io fallback...`);
  return await _fetchGateKlines(symbol, '15m', limit);
}

/**
 * Дневные свечи для Markov Regime Model: Bybit → Binance → Gate.io
 * interval: Bybit='D', Binance='1d', Gate.io='1d'
 */
export async function fetchPublicDailyOHLCV(symbol, limit = 220) {
  try {
    return await _fetchBybitKlines(symbol, 'D', limit);
  } catch (e) {
    console.log(`[OHLCV-D] Bybit: ${e.message.slice(0, 80)}`);
  }
  try {
    const r = await _fetchBinanceKlines(symbol, '1d', limit);
    console.log(`[OHLCV-D] Binance ✅`);
    return r;
  } catch (e) {
    console.log(`[OHLCV-D] Binance: ${e.message.slice(0, 80)}`);
  }
  console.log(`[OHLCV-D] Gate.io fallback...`);
  return await _fetchGateKlines(symbol, '1d', limit);
}

/** Bybit Futures kline — прямой HTTP без CCXT */
function _fetchBybitKlines(symbol, interval, limit) {
  // SOL/USDT:USDT → SOLUSDT
  const sym  = symbol.replace('/', '').replace(':USDT', '');
  const path = `/v5/market/kline?category=linear&symbol=${sym}&interval=${interval}&limit=${limit}`;
  return _httpsGet('api.bybit.com', path).then(raw => {
    const json = JSON.parse(raw);
    if (json.retCode !== 0) throw new Error(`Bybit: ${json.retMsg}`);
    // Bybit: от новых к старым → реверс
    return json.result.list.reverse().map(([t, o, h, l, c, v]) => ({
      time: parseInt(t), open: parseFloat(o), high: parseFloat(h),
      low:  parseFloat(l), close: parseFloat(c), volume: parseFloat(v),
    }));
  });
}

/** Binance USDM Futures kline — фолбэк #1 */
function _fetchBinanceKlines(symbol, interval, limit) {
  // SOL/USDT:USDT → SOLUSDT. interval передаётся как есть: '15m', '1d' и т.д.
  const sym  = symbol.replace('/', '').replace(':USDT', '');
  const path = `/fapi/v1/klines?symbol=${sym}&interval=${interval}&limit=${limit}`;
  return _httpsGet('fapi.binance.com', path).then(raw => {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error(`Binance blocked: ${raw.slice(0, 120)}`);
    // Binance: [openTime, open, high, low, close, volume, ...]
    return arr.map(([t, o, h, l, c, v]) => ({
      time: parseInt(t), open: parseFloat(o), high: parseFloat(h),
      low:  parseFloat(l), close: parseFloat(c), volume: parseFloat(v),
    }));
  });
}

/** Gate.io USDT Futures kline — фолбэк #2 (нет US блокировок) */
function _fetchGateKlines(symbol, interval, limit) {
  // SOL/USDT:USDT → SOL_USDT. interval как есть: '15m', '1d' и т.д.
  const sym  = symbol.split('/')[0] + '_USDT';
  const path = `/api/v4/futures/usdt/candlesticks?contract=${sym}&interval=${interval}&limit=${limit}`;
  return _httpsGet('api.gateio.ws', path).then(raw => {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error(`Gate.io: ${raw.slice(0, 120)}`);
    // Gate.io: [{t, o, h, l, c, v, sum}, ...] — от старых к новым
    return arr.map(bar => ({
      time:   parseInt(bar.t) * 1000,  // Gate.io в секундах → мс
      open:   parseFloat(bar.o),
      high:   parseFloat(bar.h),
      low:    parseFloat(bar.l),
      close:  parseFloat(bar.c),
      volume: parseFloat(bar.v),
    }));
  });
}

/** Простой HTTPS GET с таймаутом */
function _httpsGet(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname, path, timeout: 20000 }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => resolve(raw));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`timeout ${hostname}`)); });
    req.on('error', reject);
  });
}

function getExchange() {
  if (!exchange) {
    const isLive = process.env.LIVE_TRADING === 'true';
    exchange = new ccxt.bybit({
      apiKey: process.env.BYBIT_API_KEY,
      secret: process.env.BYBIT_SECRET,
      options: {
        defaultType: 'swap',
        recvWindow: 5000,
        fetchCurrencies: false,
        categories: ['linear'],
      },
      sandbox: !isLive,
      timeout: 20000,
    });

    // Патч: заставляем CCXT грузить ТОЛЬКО linear рынки.
    // Без патча CCXT при loadMarkets() запрашивает category=spot,
    // который заблокирован CloudFront на Railway US-West IP.
    const origFetch = exchange.fetchMarkets.bind(exchange);
    exchange.fetchMarkets = (params = {}) => origFetch({ category: 'linear', ...params });

    console.log(`[Bybit] Режим: ${isLive ? '🔴 РЕАЛЬНЫЙ' : '🟡 TESTNET'}`);
  }
  return exchange;
}

/**
 * Получить текущий баланс USDT на фьючерсном счёте
 */
export async function getBalance() {
  const ex = getExchange();
  const balance = await ex.fetchBalance({ type: 'linear' });
  return balance?.USDT?.free ?? 0;
}

/**
 * Установить кредитное плечо для символа
 */
export async function setLeverage(symbol, leverage) {
  const ex = getExchange();
  try {
    await ex.setLeverage(leverage, symbol);
    console.log(`[Bybit] Плечо ${leverage}x установлено для ${symbol}`);
  } catch (e) {
    // Игнорируем ошибку если плечо уже установлено
    if (!e.message.includes('leverage not modified')) {
      throw e;
    }
  }
}

/**
 * Получить текущие открытые позиции
 */
export async function getPositions() {
  const ex = getExchange();
  const positions = await ex.fetchPositions();
  return positions.filter(p => Math.abs(p.contracts ?? 0) > 0);
}

/**
 * Открыть позицию с SL и TP
 * @param {string} symbol - например 'SEI/USDT:USDT'
 * @param {string} side   - 'buy' (long) или 'sell' (short)
 * @param {number} sl     - цена стоп-лосса
 * @param {number} tp     - цена тейк-профита
 * @param {number} sizePct - % от баланса (по умолчанию из .env)
 */
export async function openPosition({ symbol, side, sl, tp, sizePct }) {
  const ex = getExchange();
  const leverage = parseInt(process.env.LEVERAGE ?? '5');
  const pct = sizePct ?? parseFloat(process.env.POSITION_SIZE_PCT ?? '10');

  // 1. Установить плечо
  await setLeverage(symbol, leverage);

  // 2. Получить баланс и рассчитать размер
  const balance = await getBalance();
  const ticker = await ex.fetchTicker(symbol);
  const price = ticker.last;
  const notional = (balance * pct / 100) * leverage;
  const market = ex.market(symbol);
  const amount = parseFloat((notional / price).toFixed(market.precision.amount));

  console.log(`[Bybit] Открываю ${side.toUpperCase()} ${symbol}`);
  console.log(`  Баланс: $${balance.toFixed(2)}, Размер: ${amount} (${pct}% × ${leverage}x)`);
  console.log(`  Цена: ${price}, SL: ${sl}, TP: ${tp}`);

  // 3. Рыночный ордер
  const order = await ex.createOrder(symbol, 'market', side, amount, undefined, {
    timeInForce: 'GTC',
    // Для Bybit V5: устанавливаем SL/TP прямо в ордере
    stopLoss: sl.toString(),
    takeProfit: tp.toString(),
  });

  console.log(`[Bybit] ✅ Ордер исполнен: ${order.id}`);
  return { order, balance, amount, price };
}

/**
 * Закрыть позицию по символу
 */
export async function closePosition(symbol) {
  const ex = getExchange();
  const positions = await getPositions();
  const pos = positions.find(p => p.symbol === symbol);

  if (!pos) {
    console.log(`[Bybit] Позиция по ${symbol} не найдена`);
    return null;
  }

  const side = pos.side === 'long' ? 'sell' : 'buy';
  const amount = Math.abs(pos.contracts);

  const order = await ex.createOrder(symbol, 'market', side, amount, undefined, {
    reduceOnly: true,
  });

  console.log(`[Bybit] ✅ Позиция ${symbol} закрыта`);
  return order;
}
