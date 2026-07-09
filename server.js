import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { getAccountBalances, getTickers24h } from './binance.js';
import { readJSON, writeJSON } from './store.js';
import { symbolFor } from './rules.js';
import { evaluateLadder, nextPendingLevel, pctSold, nextActionText, suggestedOrder, changePctFromEntry } from './ladder.js';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Servir archivos estáticos del frontend
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// API: Obtener balances reales de Binance
app.get('/api/balances', async (req, res) => {
  try {
    if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET) {
      return res.status(400).json({ error: 'Claves de Binance no configuradas en .env' });
    }
    const balances = await getAccountBalances(process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET);
    res.json(balances);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Obtener registro de alertas
app.get('/api/alerts', async (req, res) => {
  try {
    const log = await readJSON('alerts-log.json', []);
    res.json(log);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Obtener reglas activas
app.get('/api/rules', async (req, res) => {
  try {
    const rules = await readJSON('rules.json', []);
    res.json(rules);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Obtener mercado actual (Tracker)
app.get('/api/market', async (req, res) => {
  try {
    const rules = await readJSON('rules.json', []);
    let balances = [];
    if (process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET) {
      try { balances = await getAccountBalances(process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET); } catch(e){}
    }
    const coins = new Set([...rules.map(r => r.coin), ...balances.map(b => b.asset)]);
    // Quitar USDT si está en balances
    coins.delete('USDT');
    const symbols = Array.from(coins).map(c => `${c}USDT`);
    const tickers = await getTickers24h(symbols);
    
    // Formatear la respuesta
    const marketData = Array.from(coins).map(coin => {
      const ticker = tickers[`${coin}USDT`];
      return {
        coin,
        price: ticker ? ticker.price : null,
        changePercent: ticker ? ticker.changePercent : null
      };
    }).filter(d => d.price !== null);
    
    res.json(marketData);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Añadir nueva regla
app.post('/api/rules', async (req, res) => {
  try {
    const rules = await readJSON('rules.json', []);
    const newRule = {
      id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 9),
      active: true,
      ...req.body
    };
    rules.push(newRule);
    await writeJSON('rules.json', rules);
    res.json(newRule);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Borrar regla
app.delete('/api/rules/:id', async (req, res) => {
  try {
    const rules = await readJSON('rules.json', []);
    const filtered = rules.filter(r => r.id !== req.params.id);
    await writeJSON('rules.json', filtered);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Cartera — posiciones con P&L calculado en vivo (reemplaza al Tracker.xlsx manual)
app.get('/api/portfolio', async (req, res) => {
  try {
    const positions = await readJSON('positions.json', []);
    let balances = [];
    if (process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET) {
      try { balances = await getAccountBalances(process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET); } catch (e) {}
    }
    const symbols = positions.map((p) => symbolFor(p.coin));
    const tickers = await getTickers24h(symbols);

    const rows = positions.map((p) => {
      const ticker = tickers[symbolFor(p.coin)];
      const holding = balances.find((b) => b.asset === p.coin.toUpperCase());
      const holdingAmount = holding ? holding.free + holding.locked : 0;
      const currentPrice = ticker ? ticker.price : null;
      const changePct = currentPrice !== null ? changePctFromEntry(p.entryPrice, currentPrice) : null;
      const valorActual = currentPrice !== null ? holdingAmount * currentPrice : null;
      const pending = nextPendingLevel(p);
      const hit = currentPrice !== null ? evaluateLadder(p, currentPrice) : null;

      return {
        coin: p.coin,
        block: p.block,
        notes: p.notes || '',
        entryPrice: p.entryPrice,
        currentPrice,
        changePct,
        holdingAmount,
        valorActual,
        levels: p.levels.map((l) => ({
          ...l,
          precioObjetivo: p.entryPrice * (1 + l.pct / 100),
        })),
        pctVendido: pctSold(p),
        proximaAccion: currentPrice !== null ? nextActionText(p, changePct) : 'Sin precio de referencia',
        nivelCruzadoPendiente: hit ? { pct: hit.level.pct, levelIndex: hit.levelIndex } : null,
        pendienteInfo: pending ? { pct: pending.pct, sellPct: pending.sellPct } : null,
      };
    });

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Preparar orden para un nivel específico (no ejecuta nada, solo calcula)
app.get('/api/portfolio/:coin/order/:levelIndex', async (req, res) => {
  try {
    const positions = await readJSON('positions.json', []);
    const position = positions.find((p) => p.coin.toUpperCase() === req.params.coin.toUpperCase());
    if (!position) return res.status(404).json({ error: 'Posición no encontrada' });
    const level = position.levels[Number(req.params.levelIndex)];
    if (!level) return res.status(404).json({ error: 'Nivel no encontrado' });

    let balances = [];
    if (process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET) {
      try { balances = await getAccountBalances(process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET); } catch (e) {}
    }
    const holding = balances.find((b) => b.asset === position.coin.toUpperCase());
    const holdingAmount = holding ? holding.free + holding.locked : 0;

    const tickers = await getTickers24h([symbolFor(position.coin)]);
    const ticker = tickers[symbolFor(position.coin)];
    if (!ticker) return res.status(500).json({ error: 'No se pudo leer el precio actual' });

    const order = suggestedOrder(position.coin, holdingAmount, level.sellPct, ticker.price);
    res.json({ ...order, level, taxReserveSugerida: order.approxValueUSD * 0.3 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Editar una posición (precio de entrada, bloque, notas, niveles)
app.put('/api/positions/:coin', async (req, res) => {
  try {
    const positions = await readJSON('positions.json', []);
    const idx = positions.findIndex((p) => p.coin.toUpperCase() === req.params.coin.toUpperCase());
    if (idx === -1) return res.status(404).json({ error: 'Posición no encontrada' });
    positions[idx] = { ...positions[idx], ...req.body, coin: positions[idx].coin };
    await writeJSON('positions.json', positions);
    res.json(positions[idx]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Marcar un nivel como vendido (o deshacer) — tú confirmas que ya ejecutaste la orden
app.post('/api/positions/:coin/levels/:levelIndex/mark-sold', async (req, res) => {
  try {
    const positions = await readJSON('positions.json', []);
    const idx = positions.findIndex((p) => p.coin.toUpperCase() === req.params.coin.toUpperCase());
    if (idx === -1) return res.status(404).json({ error: 'Posición no encontrada' });
    const level = positions[idx].levels[Number(req.params.levelIndex)];
    if (!level) return res.status(404).json({ error: 'Nivel no encontrado' });
    level.sold = req.body.sold !== undefined ? !!req.body.sold : true;
    level.soldAt = level.sold ? new Date().toISOString() : null;
    await writeJSON('positions.json', positions);
    res.json(positions[idx]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Ciclo de mercado — dominancia BTC + ratio ETH/BTC para la revisión táctica de los viernes
app.get('/api/cycle', async (req, res) => {
  try {
    let btcDominance = null;
    try {
      const globalRes = await axios.get('https://api.coingecko.com/api/v3/global');
      btcDominance = globalRes.data.data.market_cap_percentage.btc;
    } catch (e) {
      console.error('No se pudo leer dominancia BTC de CoinGecko:', e.message);
    }

    const tickers = await getTickers24h(['BTCUSDT', 'ETHUSDT']);
    const btc = tickers['BTCUSDT'];
    const eth = tickers['ETHUSDT'];
    const ethBtcRatio = btc && eth ? eth.price / btc.price : null;

    let signal = 'Sin datos suficientes.';
    if (btcDominance !== null && eth && btc) {
      if (eth.changePercent > btc.changePercent) {
        signal = 'ETH está ganando fuerza relativa frente a BTC en las últimas 24h — vigila si el ratio ETH/BTC sigue subiendo (posible rotación temprana).';
      } else {
        signal = 'BTC sigue liderando en las últimas 24h — todavía no hay señal clara de rotación hacia altcoins.';
      }
    }

    res.json({
      btcDominance,
      ethBtcRatio,
      btcChange24h: btc ? btc.changePercent : null,
      ethChange24h: eth ? eth.changePercent : null,
      signal,
      altseasonIndexLink: 'https://www.blockchaincenter.net/altcoin-season-index/',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export function startServer() {
  app.listen(PORT, () => {
    console.log(`🌐 Dashboard web disponible en http://localhost:${PORT}`);
  });
}
