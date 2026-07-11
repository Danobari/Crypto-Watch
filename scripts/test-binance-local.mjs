// Prueba independiente: ¿tu IP de casa puede hablar con Binance sin ban?
//
// A propósito NO importa nada de binance.js/db.js — ese freno de emergencia
// ahora vive en Supabase y quedó marcado por el ban de la IP de Render. Si
// este script reusara esa misma bandera, pensaría que también está baneado
// aunque tu conexión de casa esté completamente limpia. Esta prueba manda
// requests reales y directos a Binance, sin pasar por ningún freno, para
// medir la verdad de tu propia IP.
//
// Cómo correrlo:
//   node scripts/test-binance-local.mjs
//
// Necesita BINANCE_API_KEY y BINANCE_API_SECRET en tu .env local (el mismo
// que ya usas para correr el proyecto).

import 'dotenv/config';
import axios from 'axios';
import crypto from 'crypto';

const BASE_URL = 'https://api.binance.com';

function sign(queryString, secret) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

function logRateLimitHeaders(headers, label) {
  if (!headers) return;
  const usedWeight = headers['x-mbx-used-weight-1m'];
  const retryAfter = headers['retry-after'];
  if (usedWeight !== undefined) {
    console.log(`   peso usado en el último minuto: ${usedWeight}/1200${retryAfter ? `, Retry-After: ${retryAfter}s` : ''}`);
  }
}

async function testPublicTicker() {
  console.log('\n1) Probando endpoint PÚBLICO (sin API key) — ticker de BTCUSDT...');
  try {
    const res = await axios.get(`${BASE_URL}/api/v3/ticker/24hr`, { params: { symbol: 'BTCUSDT' } });
    logRateLimitHeaders(res.headers, 'ticker');
    console.log(`   ✅ OK — precio BTC: $${res.data.lastPrice}`);
    return true;
  } catch (e) {
    logRateLimitHeaders(e.response?.headers, 'ticker (error)');
    console.log(`   ❌ FALLÓ — status ${e.response?.status}: ${e.response?.data?.msg || e.message}`);
    return false;
  }
}

async function testPrivateBalances() {
  console.log('\n2) Probando endpoint PRIVADO (con tu API key) — saldos de la cuenta...');
  const apiKey = process.env.BINANCE_API_KEY;
  const apiSecret = process.env.BINANCE_API_SECRET;
  if (!apiKey || !apiSecret) {
    console.log('   ⚠️  No encontré BINANCE_API_KEY / BINANCE_API_SECRET en tu .env — me salto esta prueba.');
    return null;
  }

  const timestamp = Date.now();
  const query = `timestamp=${timestamp}&recvWindow=5000`;
  const signature = sign(query, apiSecret);
  const url = `${BASE_URL}/api/v3/account?${query}&signature=${signature}`;

  try {
    const res = await axios.get(url, { headers: { 'X-MBX-APIKEY': apiKey } });
    logRateLimitHeaders(res.headers, 'account');
    const balances = res.data.balances.filter((b) => parseFloat(b.free) + parseFloat(b.locked) > 0);
    console.log(`   ✅ OK — ${balances.length} activo(s) con saldo encontrados.`);
    return true;
  } catch (e) {
    logRateLimitHeaders(e.response?.headers, 'account (error)');
    console.log(`   ❌ FALLÓ — status ${e.response?.status}: ${e.response?.data?.msg || e.message}`);
    return false;
  }
}

console.log('=== Prueba: Binance desde tu IP local (no la de Render) ===');
const publicOk = await testPublicTicker();
const privateOk = await testPrivateBalances();

console.log('\n=== Resultado ===');
if (publicOk && privateOk !== false) {
  console.log('✅ Tu IP de casa SÍ puede hablar con Binance sin problema.');
  console.log('   Esto confirma que el bloqueo es específico de la IP compartida de Render,');
  console.log('   no de tu cuenta ni de la API key. Con esto ya sabemos que mover el llamado');
  console.log('   a Binance a un lugar con IP propia (tu compu, o un proxy pago) sí resolvería el problema.');
} else {
  console.log('❌ Tu IP de casa también fue bloqueada o hubo un error.');
  console.log('   Esto cambia el diagnóstico — habría que revisar si es la cuenta/API key,');
  console.log('   o si tu proveedor de internet también comparte IP con otros clientes.');
}
