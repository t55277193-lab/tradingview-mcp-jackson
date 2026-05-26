import ccxt from 'ccxt';

/**
 * Bybit Futures клиент
 * Поддерживает USDT-маржинальные perpetual контракты
 */

let exchange = null;
let publicExchange = null;

/**
 * Публичный exchange для загрузки OHLCV (без аутентификации)
 * Используется сканером — не требует API ключей
 */
export function getExchangePublic() {
  if (!publicExchange) {
    publicExchange = new ccxt.bybit({
      options: { defaultType: 'swap', fetchCurrencies: false, categories: ['linear'] },
      timeout: 20000,
    });
  }
  return publicExchange;
}

function getExchange() {
  if (!exchange) {
    const isLive = process.env.LIVE_TRADING === 'true';
    exchange = new ccxt.bybit({
      apiKey: process.env.BYBIT_API_KEY,
      secret: process.env.BYBIT_SECRET,
      options: {
        defaultType: 'swap',       // USDT-маржинальные perpetual (фьючерсы)
        recvWindow: 5000,
        // Загружать только нужные рынки — быстрее и надёжнее
        fetchCurrencies: false,    // не загружать список монет (медленно на testnet)
        categories: ['linear'],    // только USDT-perpetual
      },
      sandbox: !isLive,            // true = testnet, false = production
      timeout: 20000,
    });
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
