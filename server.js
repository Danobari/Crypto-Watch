import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAccountBalances, getTickers24h } from './binance.js';
import { readJSON, writeJSON } from './store.js';
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

export function startServer() {
  app.listen(PORT, () => {
    console.log(`🌐 Dashboard web disponible en http://localhost:${PORT}`);
  });
}
