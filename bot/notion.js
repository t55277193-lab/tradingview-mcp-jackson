import https from 'https';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DB_ID = process.env.NOTION_DB_ID;

// Определить сессию по UTC времени
function detectSession(date = new Date()) {
  const h = date.getUTCHours();
  if (h >= 7 && h < 10) return 'LOKZ';
  if (h >= 13 && h < 16) return 'NYKZ';
  if (h >= 2 && h < 5) return 'LCKZ';
  return 'Out of KZ';
}

// Извлечь монету из символа: 'SOL/USDT:USDT' → 'SOL | USDT'
function toTradingPair(symbol) {
  const base = symbol.split('/')[0];
  return `${base} | USDT`;
}

function notionRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.notion.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve({ error: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Создать запись о сделке при открытии позиции
 * Возвращает page_id для последующего обновления при закрытии
 */
export async function logTradeOpen({ symbol, action, price, sl, tp, amount, tradeNum }) {
  if (!NOTION_TOKEN || !NOTION_DB_ID) {
    console.log('[Notion] Токен или DB ID не настроены, пропускаем');
    return null;
  }

  const now = new Date();
  const direction = action === 'long' ? 'Long' : 'Short';
  const pair = toTradingPair(symbol);
  const session = detectSession(now);
  const slPct = price > 0 ? Math.abs((sl - price) / price * 100) : 0.3;
  const tradeName = `${symbol.split('/')[0]} ${direction} #${tradeNum}`;

  const body = {
    parent: { database_id: NOTION_DB_ID },
    properties: {
      'Сделка':         { title: [{ text: { content: tradeName } }] },
      'Дата&Время':     { date: { start: now.toISOString() } },
      'Торговая пара':  { select: { name: pair } },
      'Направление':    { select: { name: direction } },
      'Сессия':         { select: { name: session } },
      'RR':             { number: 3 },
      'SL %':           { number: parseFloat(slPct.toFixed(2)) },
      'Сделка №':       { number: tradeNum },
      'Сделка открыта во время KZ?':   { checkbox: session !== 'Out of KZ' },
      'Сделка проверена на бэктестах?': { checkbox: true },
      'Сделка по тренду HTF?':         { checkbox: true },
      'Заметки': {
        rich_text: [{
          text: {
            content: `Цена входа: ${price} | SL: ${sl?.toFixed?.(4) ?? sl} | TP: ${tp?.toFixed?.(4) ?? tp} | Размер: ${amount}`
          }
        }]
      }
    }
  };

  try {
    const res = await notionRequest('POST', '/v1/pages', body);
    if (res.id) {
      console.log(`[Notion] ✅ Сделка записана: ${tradeName} (page: ${res.id})`);
      return res.id;
    } else {
      console.error('[Notion] Ошибка создания записи:', JSON.stringify(res).slice(0, 200));
      return null;
    }
  } catch(e) {
    console.error('[Notion] Исключение:', e.message);
    return null;
  }
}

/**
 * Обновить запись при закрытии позиции (Win/Loss)
 */
export async function logTradeClose({ pageId, pnl }) {
  if (!NOTION_TOKEN || !pageId) return;

  const result = pnl > 0 ? 'Win' : pnl < 0 ? 'Loss' : 'Breakeven';

  try {
    await notionRequest('PATCH', `/v1/pages/${pageId}`, {
      properties: {
        'Результат': { select: { name: result } },
        'Заметки': {
          rich_text: [{
            text: { content: `P&L: ${pnl > 0 ? '+' : ''}${pnl?.toFixed?.(2) ?? pnl} USDT` }
          }]
        }
      }
    });
    console.log(`[Notion] ✅ Результат обновлён: ${result} (${pnl} USDT)`);
  } catch(e) {
    console.error('[Notion] Ошибка обновления:', e.message);
  }
}
