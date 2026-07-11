import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { getAccountBalances, getTickers24h } from './binance.js';
import {
  getRules,
  addRule,
  deleteRule,
  getPositions,
  getPosition,
  savePosition,
  getAlertsLog,
  getCyclePhase,
  saveCyclePhase,
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
} from './db.js';
import { symbolFor } from './rules.js';
import { evaluateLadder, nextPendingLevel, pctSold, nextActionText, suggestedOrder, changePctFromEntry, opportunityCost } from './ladder.js';
import { getCBBI, cbbiPhaseLabel } from './cycle.js';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Protección con contraseña. Sin esto, cualquiera con el link de Render
// puede ver tu cartera completa. Se activa solo si DASH_USER / DASH_PASS
// están definidas en el entorno (Render → Environment) — si no están, la
// app sigue funcionando sin login, útil para desarrollo local, pero en
// producción SIEMPRE deben estar configuradas.
//
// Usamos una pantalla de login propia (con el mismo look del dashboard) en
// vez del cuadro nativo de HTTP Basic Auth que muestra el navegador — ese
// cuadro no se puede personalizar y se ve como una alerta genérica del
// sistema. Al validar usuario/contraseña se deja una cookie de sesión
// firmada (HMAC), válida 30 días o hasta el próximo reinicio del proceso
// (la clave de firma se genera nueva en cada arranque, así que un redeploy
// cierra la sesión y toca volver a entrar — aceptable para uso personal).
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');
const SESSION_COOKIE = 'ct_session';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function signSessionPayload(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
}

function createSessionToken() {
  const payload = `ok.${Date.now() + SESSION_MAX_AGE_MS}`;
  return `${payload}.${signSessionPayload(payload)}`;
}

function isValidSessionToken(token) {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [tag, expiresStr, sig] = parts;
  if (!timingSafeEqualStr(sig, signSessionPayload(`${tag}.${expiresStr}`))) return false;
  const expires = Number(expiresStr);
  return tag === 'ok' && expires > Date.now();
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function loginPageHtml({ error } = {}) {
  const errorHtml = error ? `<div class="login-error">${error}</div>` : '';
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Iniciar sesión — CryptoTracker</title>
  <link rel="icon" type="image/png" href="assets/favicon.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="styles.css">
  <style>
    body { align-items: center; justify-content: center; }
    .login-card { width: 100%; max-width: 380px; padding: 2.5rem; border-radius: 20px; }
    .login-card .logo { justify-content: center; margin-bottom: 2rem; }
    .login-card h2 { font-size: 1.05rem; margin-bottom: 1.75rem; text-align: center; color: var(--text-secondary); font-weight: 400; }
    .login-field { margin-bottom: 1.25rem; }
    .login-field label { display: block; font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.4rem; }
    .login-field input {
      width: 100%; padding: 0.75rem 1rem; border-radius: 10px;
      border: 1px solid var(--border-glass); background: rgba(255,255,255,0.03);
      color: var(--text-primary); font-family: var(--font-main); font-size: 1rem;
    }
    .login-field input:focus { outline: none; border-color: var(--accent-color); box-shadow: 0 0 0 3px var(--accent-glow); }
    .login-btn {
      width: 100%; padding: 0.85rem; border-radius: 10px; border: none; margin-top: 0.5rem;
      background: var(--accent-color); color: #fff; font-family: var(--font-main); font-size: 1rem; font-weight: 600;
      cursor: pointer; transition: filter 0.15s;
    }
    .login-btn:hover { filter: brightness(1.1); }
    .login-error {
      background: rgba(239, 68, 68, 0.1); border: 1px solid var(--danger-color); color: #fca5a5;
      padding: 0.65rem 1rem; border-radius: 8px; font-size: 0.85rem; margin-bottom: 1.25rem; text-align: center;
    }
  </style>
</head>
<body>
  <div class="login-card glass-panel">
    <div class="logo">
      <img src="assets/iahora-bolt.png" alt="IAhora" class="logo-icon">
      <h1>CryptoTracker</h1>
    </div>
    <h2>Acceso privado — ingresa tus credenciales</h2>
    ${errorHtml}
    <form method="POST" action="/login">
      <div class="login-field">
        <label for="user">Usuario</label>
        <input type="text" id="user" name="user" autocomplete="username" required autofocus>
      </div>
      <div class="login-field">
        <label for="pass">Contraseña</label>
        <input type="password" id="pass" name="pass" autocomplete="current-password" required>
      </div>
      <button type="submit" class="login-btn">Entrar</button>
    </form>
  </div>
</body>
</html>`;
}

app.use(express.urlencoded({ extended: false }));

app.get('/login', (req, res) => {
  if (!process.env.DASH_USER || !process.env.DASH_PASS) return res.redirect('/');
  res.type('html').send(loginPageHtml());
});

app.post('/login', (req, res) => {
  const user = process.env.DASH_USER;
  const pass = process.env.DASH_PASS;
  if (!user || !pass) return res.redirect('/');

  const reqUser = (req.body && req.body.user) || '';
  const reqPass = (req.body && req.body.pass) || '';
  if (timingSafeEqualStr(reqUser, user) && timingSafeEqualStr(reqPass, pass)) {
    res.cookie(SESSION_COOKIE, createSessionToken(), {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
      maxAge: SESSION_MAX_AGE_MS,
      path: '/',
    });
    return res.redirect('/');
  }
  res.status(401).type('html').send(loginPageHtml({ error: 'Usuario o contraseña incorrectos.' }));
});

app.get('/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.redirect('/login');
});

app.use((req, res, next) => {
  const user = process.env.DASH_USER;
  const pass = process.env.DASH_PASS;
  if (!user || !pass) return next(); // sin credenciales configuradas, no se exige login

  // Estáticos que necesita la propia pantalla de login para verse bien.
  if (req.path === '/styles.css' || req.path.startsWith('/assets/')) return next();

  const cookies = parseCookies(req.headers.cookie);
  if (isValidSessionToken(cookies[SESSION_COOKIE])) return next();

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'No autenticado. Inicia sesión de nuevo.' });
  }
  return res.redirect('/login');
});

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
    const log = await getAlertsLog();
    res.json(log);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Obtener reglas activas
app.get('/api/rules', async (req, res) => {
  try {
    const rules = await getRules();
    res.json(rules);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Obtener mercado actual (Tracker)
app.get('/api/market', async (req, res) => {
  try {
    const rules = await getRules();
    const watchlist = await getWatchlist();
    let balances = [];
    if (process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET) {
      try { balances = await getAccountBalances(process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET); } catch(e){}
    }
    const coins = new Set([...rules.map(r => r.coin), ...balances.map(b => b.asset), ...watchlist]);
    // Quitar USDT si está en balances
    coins.delete('USDT');
    const symbols = Array.from(coins).map(c => `${c}USDT`);
    const tickers = await getTickers24h(symbols);
    const watchlistSet = new Set(watchlist);

    // Formatear la respuesta
    const marketData = Array.from(coins).map(coin => {
      const ticker = tickers[`${coin}USDT`];
      return {
        coin,
        price: ticker ? ticker.price : null,
        changePercent: ticker ? ticker.changePercent : null,
        inWatchlist: watchlistSet.has(coin),
      };
    }).filter(d => d.price !== null);

    res.json(marketData);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Watchlist — monedas que quieres ver en Mercado aunque no las tengas
// en tu balance ni tengan una regla de alerta.
app.get('/api/watchlist', async (req, res) => {
  try {
    const watchlist = await getWatchlist();
    res.json(watchlist);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/watchlist', async (req, res) => {
  try {
    const coin = (req.body.coin || '').trim().toUpperCase();
    if (!coin) return res.status(400).json({ error: 'Falta la moneda (ej. BTC)' });
    await addToWatchlist(coin);
    res.json({ success: true, coin });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/watchlist/:coin', async (req, res) => {
  try {
    await removeFromWatchlist(req.params.coin);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Añadir nueva regla
app.post('/api/rules', async (req, res) => {
  try {
    const newRule = {
      id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 9),
      active: true,
      ...req.body
    };
    const saved = await addRule(newRule);
    res.json(saved);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Borrar regla
app.delete('/api/rules/:id', async (req, res) => {
  try {
    await deleteRule(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Cartera — posiciones con P&L calculado en vivo (reemplaza al Tracker.xlsx manual)
app.get('/api/portfolio', async (req, res) => {
  try {
    const positions = await getPositions();
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
      const { peakPriceSinceEntry, gananciaNoTomadaUSD, gananciaNoTomadaPct } = opportunityCost(p, currentPrice, holdingAmount);

      return {
        coin: p.coin,
        block: p.block,
        notes: p.notes || '',
        entryPrice: p.entryPrice,
        currentPrice,
        changePct,
        holdingAmount,
        valorActual,
        peakPriceSinceEntry,
        gananciaNoTomadaUSD,
        gananciaNoTomadaPct,
        levels: p.levels.map((l) => ({
          ...l,
          precioObjetivo: p.entryPrice * (1 + l.pct / 100),
        })),
        pctVendido: pctSold(p),
        proximaAccion: currentPrice !== null ? nextActionText(p, changePct) : 'Sin precio de referencia',
        nivelCruzadoPendiente: hit ? { pct: hit.level.pct, levelIndex: hit.levelIndex } : null,
        pendienteInfo: pending ? { pct: pending.pct, sellPct: pending.sellPct } : null,
        trailingStop: p.trailingStop || null,
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
    const position = await getPosition(req.params.coin);
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

// API: Preparar orden de salida por trailing stop (no ejecuta nada, solo calcula)
app.get('/api/portfolio/:coin/trailing-order', async (req, res) => {
  try {
    const position = await getPosition(req.params.coin);
    if (!position) return res.status(404).json({ error: 'Posición no encontrada' });
    if (!position.trailingStop || !position.trailingStop.triggered) {
      return res.status(400).json({ error: 'El trailing stop de esta posición todavía no se ha disparado' });
    }

    let balances = [];
    if (process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET) {
      try { balances = await getAccountBalances(process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET); } catch (e) {}
    }
    const holding = balances.find((b) => b.asset === position.coin.toUpperCase());
    const holdingAmount = holding ? holding.free + holding.locked : 0;

    const tickers = await getTickers24h([symbolFor(position.coin)]);
    const ticker = tickers[symbolFor(position.coin)];
    if (!ticker) return res.status(500).json({ error: 'No se pudo leer el precio actual' });

    const sellPct = position.trailingSellPct || 100;
    const order = suggestedOrder(position.coin, holdingAmount, sellPct, ticker.price);
    res.json({ ...order, trailingStop: position.trailingStop, taxReserveSugerida: order.approxValueUSD * 0.3 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Reiniciar el trailing stop de una posición (ej. tras ejecutarlo, o si quieres re-armarlo)
app.post('/api/positions/:coin/trailing-stop/reset', async (req, res) => {
  try {
    const position = await getPosition(req.params.coin);
    if (!position) return res.status(404).json({ error: 'Posición no encontrada' });
    position.trailingStop = { armed: false, peakPrice: null, atr: null, multiplier: null, stopPrice: null, triggered: false };
    await savePosition(position);
    res.json(position);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Editar una posición (precio de entrada, bloque, notas, niveles)
app.put('/api/positions/:coin', async (req, res) => {
  try {
    const position = await getPosition(req.params.coin);
    if (!position) return res.status(404).json({ error: 'Posición no encontrada' });
    const updated = { ...position, ...req.body, coin: position.coin };
    await savePosition(updated);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Marcar un nivel como vendido (o deshacer) — tú confirmas que ya ejecutaste la orden
app.post('/api/positions/:coin/levels/:levelIndex/mark-sold', async (req, res) => {
  try {
    const position = await getPosition(req.params.coin);
    if (!position) return res.status(404).json({ error: 'Posición no encontrada' });
    const level = position.levels[Number(req.params.levelIndex)];
    if (!level) return res.status(404).json({ error: 'Nivel no encontrado' });
    level.sold = req.body.sold !== undefined ? !!req.body.sold : true;
    level.soldAt = level.sold ? new Date().toISOString() : null;
    await savePosition(position);
    res.json(position);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Ciclo de mercado — dominancia BTC, ratio ETH/BTC, score CBBI y tu fase manual
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

    let cbbi = null;
    try {
      cbbi = await getCBBI();
    } catch (e) {
      console.error('No se pudo leer CBBI:', e.message);
    }

    let signal = 'Sin datos suficientes.';
    if (btcDominance !== null && eth && btc) {
      if (eth.changePercent > btc.changePercent) {
        signal = 'ETH está ganando fuerza relativa frente a BTC en las últimas 24h — vigila si el ratio ETH/BTC sigue subiendo (posible rotación temprana).';
      } else {
        signal = 'BTC sigue liderando en las últimas 24h — todavía no hay señal clara de rotación hacia altcoins.';
      }
    }

    const cyclePhase = await getCyclePhase();

    res.json({
      btcDominance,
      ethBtcRatio,
      btcChange24h: btc ? btc.changePercent : null,
      ethChange24h: eth ? eth.changePercent : null,
      signal,
      cbbi: cbbi ? { score: cbbi.score, asOf: cbbi.asOf, label: cbbiPhaseLabel(cbbi.score) } : null,
      cyclePhase,
      altseasonIndexLink: 'https://www.blockchaincenter.net/altcoin-season-index/',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Actualizar la fase de ciclo manual (ej. la lectura de tu GPT de indicadores on-chain).
// Esta fase ajusta qué tan ceñido es el trailing stop dinámico (ver cycle.js).
app.put('/api/cycle-phase', async (req, res) => {
  try {
    const valid = ['acumulacion', 'alcista_temprano', 'neutral', 'euforia', 'distribucion', 'bajista'];
    const phase = valid.includes(req.body.phase) ? req.body.phase : 'neutral';
    const payload = await saveCyclePhase({ phase, notes: req.body.notes, source: req.body.source });
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export function startServer() {
  app.listen(PORT, () => {
    console.log(`🌐 Dashboard web disponible en http://localhost:${PORT}`);
  });
}
