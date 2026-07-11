// Sincroniza el "Crypto Watch Tracker" en Google Sheets — reemplaza a
// excel-sync.js para el despliegue en Netlify, donde no hay disco
// persistente para editar un .xlsx local.
//
// Autenticación: OAuth (no cuenta de servicio, bloqueada por política de
// organización de Google). Usa un refresh_token de larga duración (emitido
// con la app ya en modo "Producción", así que no expira a los 7 días) para
// pedir un access_token nuevo en cada sincronización — sin backend propio
// de sesiones, sin librerías de Google, solo fetch().
//
// Requiere en el entorno: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET,
// GOOGLE_OAUTH_REFRESH_TOKEN, GOOGLE_SHEET_ID.
//
// Estructura del spreadsheet (4 pestañas, ya creadas):
//   - Cartera: una fila por posición, con P&L, niveles y trailing stop.
//   - Ciclo de Mercado: una fila por sincronización (histórico).
//   - Reglas: espejo de data/rules (Supabase).
//   - Historial de Alertas: últimas alertas disparadas.

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

async function getAccessToken() {
  const { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET || !GOOGLE_OAUTH_REFRESH_TOKEN) {
    throw new Error('Faltan GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN en el entorno.');
  }
  const body = new URLSearchParams({
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
    refresh_token: GOOGLE_OAUTH_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Google OAuth token refresh falló: ${JSON.stringify(json)}`);
  return json.access_token;
}

async function sheetsFetch(path, accessToken, options = {}) {
  const res = await fetch(`${SHEETS_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Google Sheets API (${path}) falló: ${JSON.stringify(json)}`);
  return json;
}

// Reemplaza todo el contenido de una pestaña (desde A2, dejando el
// encabezado de la fila 1 intacto) con las filas nuevas.
async function replaceSheetRows(spreadsheetId, accessToken, sheetTitle, rows) {
  // Limpia el rango de datos previo (hasta 2000 filas, de sobra para esto).
  await sheetsFetch(`/${spreadsheetId}/values/'${encodeURIComponent(sheetTitle)}'!A2:Z2000:clear`, accessToken, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  if (rows.length === 0) return;
  await sheetsFetch(`/${spreadsheetId}/values/'${encodeURIComponent(sheetTitle)}'!A2?valueInputOption=RAW`, accessToken, {
    method: 'PUT',
    body: JSON.stringify({ values: rows }),
  });
}

// Agrega filas al final de una pestaña (para el histórico de Ciclo de
// Mercado y el log de alertas — no se sobreescriben, se acumulan).
async function appendSheetRows(spreadsheetId, accessToken, sheetTitle, rows) {
  if (rows.length === 0) return;
  await sheetsFetch(
    `/${spreadsheetId}/values/'${encodeURIComponent(sheetTitle)}'!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    accessToken,
    { method: 'POST', body: JSON.stringify({ values: rows }) }
  );
}

function fmt(n, digits = 2) {
  return typeof n === 'number' && !Number.isNaN(n) ? Number(n.toFixed(digits)) : '';
}

// --- Cartera ---
// positions: salida de getPositions() (db.js). tickers/balances: de binance.js.
export function buildCarteraRows(positions, tickers, balances, symbolFor, helpers) {
  const { changePctFromEntry, nextPendingLevel, pctSold, nextActionText, opportunityCost } = helpers;
  return positions.map((p) => {
    const ticker = tickers[symbolFor(p.coin)];
    const holding = balances.find((b) => b.asset === p.coin.toUpperCase());
    const holdingAmount = holding ? holding.free + holding.locked : 0;
    const currentPrice = ticker ? ticker.price : null;
    const changePct = currentPrice !== null ? changePctFromEntry(p.entryPrice, currentPrice) : null;
    const valorActual = currentPrice !== null ? holdingAmount * currentPrice : null;
    const pending = nextPendingLevel(p);
    const levels = [0, 1, 2].map((i) => p.levels[i] || {});
    const ts = p.trailingStop || {};
    const { peakPriceSinceEntry, gananciaNoTomadaUSD, gananciaNoTomadaPct } = opportunityCost(p, currentPrice, holdingAmount);

    return [
      p.coin,
      p.block,
      fmt(p.entryPrice, 6),
      fmt(currentPrice, 6),
      fmt(changePct),
      fmt(holdingAmount, 8),
      fmt(valorActual),
      levels[0].pct ?? '',
      levels[0].sellPct ?? '',
      levels[0].sold ? 'SI' : 'NO',
      levels[1].pct ?? '',
      levels[1].sellPct ?? '',
      levels[1].sold ? 'SI' : 'NO',
      levels[2].pct ?? '',
      levels[2].sellPct ?? '',
      levels[2].sold ? 'SI' : 'NO',
      fmt(pctSold(p), 0),
      currentPrice !== null ? nextActionText(p, changePct) : 'Sin precio de referencia',
      ts.armed ? 'SI' : 'NO',
      fmt(ts.peakPrice, 6),
      fmt(ts.atr, 6),
      fmt(ts.stopPrice, 6),
      ts.triggered ? 'SI' : 'NO',
      p.notes || '',
      new Date().toISOString(),
      fmt(peakPriceSinceEntry, 6),
      fmt(gananciaNoTomadaUSD),
      fmt(gananciaNoTomadaPct),
    ];
  });
}

// --- Ciclo de Mercado (histórico: se agrega una fila por sync) ---
export function buildCicloRow(cycleData) {
  const { cyclePhase, btcDominance, ethBtcRatio, btcChange24h, ethChange24h, cbbi, signal } = cycleData;
  return [
    new Date().toISOString(),
    cyclePhase?.phase || '',
    cyclePhase?.notes || '',
    fmt(btcDominance),
    fmt(ethBtcRatio, 6),
    fmt(btcChange24h),
    fmt(ethChange24h),
    cbbi ? fmt(cbbi.score, 1) : '',
    cbbi ? cbbi.label : '',
    signal || '',
  ];
}

// --- Reglas (espejo completo, se sobreescribe cada vez) ---
export function buildReglasRows(rules) {
  return rules.map((r) => [
    r.id,
    r.coin,
    r.type,
    r.value,
    r.active !== false ? 'SI' : 'NO',
    r.order?.side || '',
    r.order?.sizeType || '',
    r.order?.sizeValue ?? '',
  ]);
}

// --- Historial de alertas ---
// Se espeja completo (igual que Cartera/Reglas) en vez de ir acumulando,
// para no tener que llevar un cursor de "hasta dónde ya se sincronizó" sin
// disco persistente. getAlertsLog() ya trae las más recientes primero.
export function buildAlertasRows(alerts) {
  return alerts.map((a) => [a.time || new Date().toISOString(), a.ruleId, a.message]);
}

// Orquestador: sincroniza las 4 pestañas de una vez.
export async function syncTrackerSheets({ positions, tickers, balances, symbolFor, helpers, cycleData, rules, alerts }) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!spreadsheetId) throw new Error('Falta GOOGLE_SHEET_ID en el entorno.');
  const accessToken = await getAccessToken();

  const carteraRows = buildCarteraRows(positions, tickers, balances, symbolFor, helpers);
  await replaceSheetRows(spreadsheetId, accessToken, 'Cartera', carteraRows);

  if (cycleData) {
    await appendSheetRows(spreadsheetId, accessToken, 'Ciclo de Mercado', [buildCicloRow(cycleData)]);
  }

  const reglasRows = buildReglasRows(rules || []);
  await replaceSheetRows(spreadsheetId, accessToken, 'Reglas', reglasRows);

  const alertasRows = buildAlertasRows(alerts || []);
  await replaceSheetRows(spreadsheetId, accessToken, 'Historial de Alertas', alertasRows);
}
