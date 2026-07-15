// Corre en tu computadora (no en Render) y alimenta a la app en la nube con
// datos reales de Binance. Confirmado con scripts/test-binance-local.mjs:
// tu IP de casa SÍ puede hablar con Binance; la IP compartida de Render, no.
//
// Este script hace UNA ronda: pide tus saldos y los precios que necesita el
// dashboard (posiciones, reglas, BTC/ETH para Ciclo de Mercado), y los deja
// guardados en Supabase. La app en Render (binance.js) solo lee ese
// snapshot — nunca llama a Binance por su cuenta.
//
// Está pensado para correr cada 5 minutos vía una tarea programada de
// macOS (launchd) — ver README para la instalación paso a paso. También lo
// puedes correr a mano en cualquier momento: node scripts/binance-local-poller.mjs

import 'dotenv/config';
import { fetchAccountBalances, fetchTickers24h, fetchDailyCloses } from '../binance-live.js';
import {
  getRules,
  getPositions,
  getWatchlist,
  saveBinanceBalancesSnapshot,
  saveBinanceTickersSnapshot,
  saveTechnicalSnapshot,
} from '../db.js';
import { symbolFor } from '../rules.js';

function log(msg) {
  console.log(`[${new Date().toLocaleString()}] ${msg}`);
}

async function poll() {
  const apiKey = process.env.BINANCE_API_KEY;
  const apiSecret = process.env.BINANCE_API_SECRET;
  if (!apiKey || !apiSecret) {
    console.error('Faltan BINANCE_API_KEY / BINANCE_API_SECRET en tu .env — no puedo continuar.');
    process.exitCode = 1;
    return;
  }

  let balances = [];
  let balancesOk = false;
  try {
    balances = await fetchAccountBalances(apiKey, apiSecret);
    await saveBinanceBalancesSnapshot(balances);
    balancesOk = true;
    log(`✅ Saldos actualizados (${balances.length} activo(s) con saldo).`);
  } catch (e) {
    log(`❌ Error leyendo saldos: ${e.response?.data?.msg || e.message}`);
  }

  try {
    const [rules, positions, watchlist] = await Promise.all([getRules(), getPositions(), getWatchlist()]);
    const coins = new Set(['BTC', 'ETH']); // siempre, para la pestaña Ciclo de Mercado
    rules.forEach((r) => coins.add(r.coin));
    positions.forEach((p) => coins.add(p.coin));
    watchlist.forEach((c) => coins.add(c));
    balances.forEach((b) => {
      // USDT no tiene par contra sí mismo. Los que empiezan con "LD" son
      // saldos de productos de ahorro/Earn de Binance (ej. LDUSDC = "Locked
      // Deposit" de USDC) — no son monedas tradeables, no tienen par en
      // Binance y tumbarían el pedido agrupado de precios si se incluyen.
      if (b.asset === 'USDT' || b.asset.startsWith('LD')) return;
      coins.add(b.asset);
    });

    const symbols = Array.from(coins).map(symbolFor);
    const tickers = await fetchTickers24h(symbols);
    await saveBinanceTickersSnapshot(tickers);
    log(`✅ Precios actualizados (${Object.keys(tickers).length} símbolo(s)).`);

    // Cierres diarios — solo para las monedas con reglas activas, que son
    // las únicas que pueden usar condiciones de SMA/EMA/RSI/volumen. Se
    // descartan por separado los que fallen (ej. un símbolo raro sin
    // suficiente historial) para no perder los demás.
    const ruleCoins = Array.from(new Set(rules.map((r) => r.coin.toUpperCase())));
    if (ruleCoins.length > 0) {
      const closesByCoin = {};
      for (const coin of ruleCoins) {
        try {
          closesByCoin[coin] = await fetchDailyCloses(symbolFor(coin), 210);
        } catch (e) {
          log(`   ⚠️  No se pudieron traer velas de ${coin}: ${e.response?.data?.msg || e.message}`);
        }
      }
      if (Object.keys(closesByCoin).length > 0) {
        await saveTechnicalSnapshot(closesByCoin);
        log(`✅ Indicadores técnicos actualizados (${Object.keys(closesByCoin).length} moneda(s)).`);
      }
    }
  } catch (e) {
    log(`❌ Error leyendo precios: ${e.response?.data?.msg || e.message}`);
  }

  if (!balancesOk) process.exitCode = 1;
}

poll();
