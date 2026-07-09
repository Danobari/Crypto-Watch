import axios from 'axios';
import crypto from 'crypto';

const BASE_URL = 'https://api.binance.com';

function sign(queryString, secret) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

// Lee los saldos reales de tu cuenta. Requiere una API key con permiso de
// Lectura únicamente — este endpoint solo lee, nunca escribe ni ejecuta nada.
export async function getAccountBalances(apiKey, apiSecret) {
  const timestamp = Date.now();
  const query = `timestamp=${timestamp}&recvWindow=5000`;
  const signature = sign(query, apiSecret);
  const url = `${BASE_URL}/api/v3/account?${query}&signature=${signature}`;
  const res = await axios.get(url, { headers: { 'X-MBX-APIKEY': apiKey } });
  return res.data.balances
    .map((b) => ({ asset: b.asset, free: parseFloat(b.free), locked: parseFloat(b.locked) }))
    .filter((b) => b.free + b.locked > 0);
}

// Precio y cambio 24h de un símbolo (endpoint público, no requiere API key).
export async function getTicker24h(symbol) {
  const res = await axios.get(`${BASE_URL}/api/v3/ticker/24hr`, { params: { symbol } });
  return {
    symbol: res.data.symbol,
    price: parseFloat(res.data.lastPrice),
    changePercent: parseFloat(res.data.priceChangePercent),
  };
}

export async function getTickers24h(symbols) {
  const results = {};
  for (const symbol of symbols) {
    try {
      results[symbol] = await getTicker24h(symbol);
    } catch (e) {
      console.error(`No se pudo leer ${symbol}:`, e.message);
    }
  }
  return results;
}
