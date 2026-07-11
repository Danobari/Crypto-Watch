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
import { fetchAccountBalances, fetchTickers24h } from '../binance-live.js';
import { getRules, getPositions, saveBinanceBalancesSnapshot, saveBinanceTickersSnapshot } from '../db.js';
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
    const [rules, positions] = await Promise.all([getRules(), getPositions()]);
    const coins = new Set(['BTC', 'ETH']); // siempre, para la pestaña Ciclo de Mercado
    rules.forEach((r) => coins.add(r.coin));
    positions.forEach((p) => coins.add(p.coin));
    balances.forEach((b) => { if (b.asset !== 'USDT') coins.add(b.asset); });

    const symbols = Array.from(coins).map(symbolFor);
    const tickers = await fetchTickers24h(symbols);
    await saveBinanceTickersSnapshot(tickers);
    log(`✅ Precios actualizados (${Object.keys(tickers).length} símbolo(s)).`);
  } catch (e) {
    log(`❌ Error leyendo precios: ${e.response?.data?.msg || e.message}`);
  }

  if (!balancesOk) process.exitCode = 1;
}

poll();
