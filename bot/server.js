import 'dotenv/config';
import express from 'express';
import { openPosition, closePosition, getPositions } from './bybit.js';
import { logTradeOpen, logTradeClose } from './notion.js';

const app = express();
app.use(express.json());

const PORT = process.env.PORT ?? 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? '';

// ══════════════════════════════════════════
// Логирование сделок (в память + вывод)
// ══════════════════════════════════════════
const tradeLog = [];
let tradeCounter = 0;
// pageId хранится в памяти: symbol → notionPageId (для обновления при закрытии)
const notionPages = {};

function logTrade(entry) {
  const ts = new Date().toISOString();
  const record = { ts, ...entry };
  tradeLog.push(record);
  console.log(`[TRADE] ${ts}`, record);
}

// ══════════════════════════════════════════
// Маппинг символов TradingView → Bybit CCXT
// TradingView: BYBIT:SEIUSDT.P → ccxt: SEI/USDT:USDT
// ══════════════════════════════════════════
function toBybitSymbol(tvSymbol) {
  // Убираем префикс BYBIT: и суффикс .P
  const base = tvSymbol
    .replace(/^BYBIT:/i, '')
    .replace(/\.P$/i, '')
    .replace('USDT', '');
  return `${base}/USDT:USDT`;
}

// ══════════════════════════════════════════
// Middleware: проверка секрета
// ══════════════════════════════════════════
function checkSecret(req, res, next) {
  const secret = req.body?.secret ?? req.headers['x-webhook-secret'];
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    console.warn(`[Auth] Неверный секрет: ${secret}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ══════════════════════════════════════════
// Проверка лимита позиций
// ══════════════════════════════════════════
async function checkPositionLimit() {
  const maxPos = parseInt(process.env.MAX_POSITIONS ?? '2');
  const positions = await getPositions();
  if (positions.length >= maxPos) {
    return { allowed: false, current: positions.length, max: maxPos };
  }
  return { allowed: true, current: positions.length, max: maxPos };
}

// ══════════════════════════════════════════
// POST /webhook — основной эндпоинт
// ══════════════════════════════════════════
/**
 * Формат алерта из TradingView:
 * {
 *   "secret": "my_secret_token_123",
 *   "action": "long" | "short" | "close_long" | "close_short",
 *   "symbol": "BYBIT:SEIUSDT.P",
 *   "price": "{{close}}",
 *   "sl": "{{plot_0}}",   // опционально — цена SL из индикатора
 *   "tp": "{{plot_1}}",   // опционально — цена TP из индикатора
 *   "sl_pct": "0.3",      // или % от цены (если sl не задан)
 *   "rr": "3.0"           // RR для расчёта TP (если tp не задан)
 * }
 */
app.post('/webhook', checkSecret, async (req, res) => {
  const body = req.body;
  console.log(`[Webhook] Получен сигнал:`, JSON.stringify(body));

  try {
    const { action, symbol: tvSymbol, price: priceStr } = body;

    if (!action || !tvSymbol) {
      return res.status(400).json({ error: 'Нужны action и symbol' });
    }

    const symbol = toBybitSymbol(tvSymbol);
    const price = parseFloat(priceStr) || 0;

    // ЗАКРЫТИЕ позиции
    if (action === 'close_long' || action === 'close_short') {
      const order = await closePosition(symbol);
      logTrade({ action, symbol, status: order ? 'closed' : 'not_found' });
      // Обновляем Notion если есть открытая запись
      if (notionPages[symbol]) {
        const pnl = parseFloat(body.pnl ?? 0);
        await logTradeClose({ pageId: notionPages[symbol], pnl });
        delete notionPages[symbol];
      }
      return res.json({ ok: true, action, symbol });
    }

    // ОТКРЫТИЕ позиции (long / short)
    if (action !== 'long' && action !== 'short') {
      return res.status(400).json({ error: `Неизвестный action: ${action}` });
    }

    // Проверка лимита позиций
    const limit = await checkPositionLimit();
    if (!limit.allowed) {
      console.log(`[Limit] Уже открыто ${limit.current}/${limit.max} позиций, пропускаем`);
      logTrade({ action, symbol, status: 'skipped_limit' });
      return res.json({ ok: false, reason: 'position_limit', current: limit.current });
    }

    // Расчёт SL и TP
    let sl, tp;

    if (body.sl && body.tp) {
      // SL/TP переданы напрямую из TradingView
      sl = parseFloat(body.sl);
      tp = parseFloat(body.tp);
    } else {
      // Рассчитываем из процентов
      const slPct = parseFloat(body.sl_pct ?? process.env.SL_PCT ?? '0.3') / 100;
      const rr    = parseFloat(body.rr ?? process.env.RR ?? '3.0');

      if (action === 'long') {
        sl = price * (1 - slPct);
        tp = price + (price - sl) * rr;
      } else {
        sl = price * (1 + slPct);
        tp = price - (sl - price) * rr;
      }
    }

    const side = action === 'long' ? 'buy' : 'sell';
    const result = await openPosition({ symbol, side, sl, tp });
    tradeCounter++;

    logTrade({
      action, symbol, side,
      price: result.price, sl, tp,
      amount: result.amount,
      balance: result.balance,
      orderId: result.order.id,
      status: 'opened',
    });

    // Записываем в Notion
    const notionPageId = await logTradeOpen({
      symbol, action,
      price: result.price, sl, tp,
      amount: result.amount,
      tradeNum: tradeCounter,
    });
    if (notionPageId) notionPages[symbol] = notionPageId;

    return res.json({
      ok: true,
      action, symbol, side,
      price: result.price, sl, tp,
      amount: result.amount,
      orderId: result.order.id,
    });

  } catch (err) {
    console.error(`[Error] ${err.message}`, err.stack);
    logTrade({ action: body.action, symbol: body.symbol, status: 'error', error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
// GET /status — состояние бота
// ══════════════════════════════════════════
app.get('/status', async (req, res) => {
  try {
    const positions = await getPositions();
    res.json({
      ok: true,
      live: process.env.LIVE_TRADING === 'true',
      positions: positions.map(p => ({
        symbol: p.symbol,
        side: p.side,
        size: p.contracts,
        entryPrice: p.entryPrice,
        unrealizedPnl: p.unrealizedPnl?.toFixed(2),
      })),
      recentTrades: tradeLog.slice(-10),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
// GET / — health check
// ══════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({ ok: true, bot: 'SMC Trading Bot', version: '1.0' });
});

// ══════════════════════════════════════════
// Запуск сервера
// ══════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n🚀 SMC Trading Bot запущен на порту ${PORT}`);
  console.log(`   Режим: ${process.env.LIVE_TRADING === 'true' ? '🔴 РЕАЛЬНЫЙ' : '🟡 TESTNET/PAPER'}`);
  console.log(`   Webhook: POST http://localhost:${PORT}/webhook`);
  console.log(`   Статус:  GET  http://localhost:${PORT}/status`);
  console.log(`   Секрет:  ${WEBHOOK_SECRET ? '✅ настроен' : '⚠️ НЕ ЗАДАН — все запросы будут приниматься'}\n`);
});
