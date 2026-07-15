// Capa de datos sobre Supabase. Reemplaza a store.js (que leía/escribía
// data/*.json en disco) — necesario porque en un despliegue serverless
// (Netlify Functions) no hay disco persistente entre invocaciones: cada
// función arranca "fresca", así que el estado tiene que vivir en una base
// de datos real.
//
// La forma de los objetos que devuelve esta capa (camelCase: entryPrice,
// trailingStop, trailingSellPct...) es deliberadamente la misma que ya
// usaban ladder.js, index.js y server.js cuando leían directo de
// positions.json — así el resto del código casi no tuvo que cambiar.
//
// Requiere SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en el entorno. La
// service_role key nunca debe exponerse al frontend — solo la usa este
// servidor.

import { createClient } from '@supabase/supabase-js';

let client = null;

function getClient() {
  if (!client) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en el entorno.');
    }
    client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }
  return client;
}

function rowToPosition(row) {
  return {
    coin: row.coin,
    block: row.block,
    entryPrice: Number(row.entry_price),
    notes: row.notes || '',
    levels: row.levels || [],
    trailingStop: row.trailing_stop || null,
    trailingSellPct: row.trailing_sell_pct !== null ? Number(row.trailing_sell_pct) : 100,
    peakPriceSinceEntry: row.peak_price_since_entry !== null && row.peak_price_since_entry !== undefined
      ? Number(row.peak_price_since_entry)
      : null,
  };
}

function positionToRow(position) {
  return {
    coin: position.coin,
    block: position.block,
    entry_price: position.entryPrice,
    notes: position.notes || '',
    levels: position.levels || [],
    trailing_stop: position.trailingStop || null,
    trailing_sell_pct: position.trailingSellPct ?? 100,
    peak_price_since_entry: position.peakPriceSinceEntry ?? null,
    updated_at: new Date().toISOString(),
  };
}

// --- Posiciones (cartera) ---

export async function getPositions() {
  const { data, error } = await getClient().from('positions').select('*').order('coin');
  if (error) throw new Error(`Supabase (positions): ${error.message}`);
  return (data || []).map(rowToPosition);
}

export async function getPosition(coin) {
  const { data, error } = await getClient()
    .from('positions')
    .select('*')
    .ilike('coin', coin)
    .maybeSingle();
  if (error) throw new Error(`Supabase (positions): ${error.message}`);
  return data ? rowToPosition(data) : null;
}

// Guarda una posición completa (upsert). Se usa tanto para crear una
// posición nueva como para actualizar una existente tras un tick, un
// mark-sold, o una edición manual.
export async function savePosition(position) {
  const { error } = await getClient().from('positions').upsert(positionToRow(position));
  if (error) throw new Error(`Supabase (positions): ${error.message}`);
}

// Guarda varias posiciones de una vez (lo que antes hacía writeJSON con el
// array completo, ej. al final de cada tick si algo cambió).
export async function savePositions(positions) {
  if (positions.length === 0) return;
  const { error } = await getClient().from('positions').upsert(positions.map(positionToRow));
  if (error) throw new Error(`Supabase (positions): ${error.message}`);
}

// --- Fase de ciclo ---

export async function getCyclePhase() {
  const { data, error } = await getClient().from('cycle_phase').select('*').eq('id', 1).maybeSingle();
  if (error) throw new Error(`Supabase (cycle_phase): ${error.message}`);
  if (!data) return { phase: 'neutral', notes: '', source: 'manual', updatedAt: null };
  return { phase: data.phase, notes: data.notes || '', source: data.source, updatedAt: data.updated_at };
}

export async function saveCyclePhase({ phase, notes, source }) {
  const payload = { id: 1, phase, notes: notes || '', source: source || 'manual', updated_at: new Date().toISOString() };
  const { error } = await getClient().from('cycle_phase').upsert(payload);
  if (error) throw new Error(`Supabase (cycle_phase): ${error.message}`);
  return { phase: payload.phase, notes: payload.notes, source: payload.source, updatedAt: payload.updated_at };
}

// --- Reglas ad-hoc (precio / % de cambio) ---

function rowToRule(row) {
  return {
    id: row.id,
    coin: row.coin,
    type: row.type,
    value: Number(row.value),
    active: row.active,
    order: row.order_config || undefined,
  };
}

export async function getRules() {
  const { data, error } = await getClient().from('rules').select('*').order('created_at');
  if (error) throw new Error(`Supabase (rules): ${error.message}`);
  return (data || []).map(rowToRule);
}

export async function addRule(rule) {
  const row = {
    id: rule.id,
    coin: rule.coin,
    type: rule.type,
    value: rule.value,
    active: rule.active !== false,
    order_config: rule.order || null,
  };
  const { error } = await getClient().from('rules').insert(row);
  if (error) throw new Error(`Supabase (rules): ${error.message}`);
  return rowToRule(row);
}

export async function deleteRule(id) {
  const { error } = await getClient().from('rules').delete().eq('id', id);
  if (error) throw new Error(`Supabase (rules): ${error.message}`);
}

// --- Historial de alertas ---

export async function getAlertsLog(limit = 200) {
  const { data, error } = await getClient()
    .from('alerts_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Supabase (alerts_log): ${error.message}`);
  return (data || []).map((row) => ({ ruleId: row.rule_id, message: row.message, time: row.created_at }));
}

export async function appendAlert({ ruleId, message }) {
  const { error } = await getClient().from('alerts_log').insert({ rule_id: ruleId, message });
  if (error) throw new Error(`Supabase (alerts_log): ${error.message}`);
}

// --- Estado de "ya avisado" (para no repetir el mismo correo) ---

export async function getTriggeredState() {
  const { data, error } = await getClient().from('triggered_state').select('*');
  if (error) throw new Error(`Supabase (triggered_state): ${error.message}`);
  const state = {};
  for (const row of data || []) state[row.key] = row.triggered;
  return state;
}

// Recibe el objeto completo { key: bool, ... } acumulado durante un tick y
// hace upsert de cada entrada — mismo patrón que antes con triggered.json.
export async function saveTriggeredState(state) {
  const rows = Object.entries(state).map(([key, triggered]) => ({
    key,
    triggered: !!triggered,
    updated_at: new Date().toISOString(),
  }));
  if (rows.length === 0) return;
  const { error } = await getClient().from('triggered_state').upsert(rows);
  if (error) throw new Error(`Supabase (triggered_state): ${error.message}`);
}

// --- Estado del ban temporal de Binance (persistido) ---
//
// Antes vivía solo en una variable en memoria dentro de binance.js. El
// problema: si Render reinicia el proceso (crash, redeploy, o el propio
// ciclo del plan gratis) mientras el ban seguía activo en Binance, esa
// variable se resetea a 0 y la app cree que ya puede volver a llamar a
// Binance — manda un request real contra un ban que sigue activo, y
// Binance, al ver que insistes durante el ban, lo extiende (así fue como
// un ban de ~35 min pasó a marcar ~124 min tras un reinicio). Guardarlo en
// Supabase hace que el freno de emergencia sobreviva a un reinicio.

export async function getBinanceBanUntil() {
  const { data, error } = await getClient().from('binance_ban_state').select('banned_until_ms').eq('id', 1).maybeSingle();
  if (error) throw new Error(`Supabase (binance_ban_state): ${error.message}`);
  return data ? Number(data.banned_until_ms) : 0;
}

export async function saveBinanceBanUntil(bannedUntilMs) {
  const { error } = await getClient()
    .from('binance_ban_state')
    .upsert({ id: 1, banned_until_ms: bannedUntilMs, updated_at: new Date().toISOString() });
  if (error) throw new Error(`Supabase (binance_ban_state): ${error.message}`);
}

// --- Watchlist (pestaña Mercado) ---
//
// Monedas que quieres ver en "Mercado (Tracker)" aunque no las tengas en tu
// balance de Binance ni tengan una regla de alerta creada — ej. BTC/ETH
// para referencia general, o cualquier moneda que quieras vigilar.

export async function getWatchlist() {
  const { data, error } = await getClient().from('watchlist').select('coin').order('created_at');
  if (error) throw new Error(`Supabase (watchlist): ${error.message}`);
  return (data || []).map((row) => row.coin);
}

export async function addToWatchlist(coin) {
  const { error } = await getClient().from('watchlist').upsert({ coin: coin.toUpperCase() });
  if (error) throw new Error(`Supabase (watchlist): ${error.message}`);
}

export async function removeFromWatchlist(coin) {
  const { error } = await getClient().from('watchlist').delete().eq('coin', coin.toUpperCase());
  if (error) throw new Error(`Supabase (watchlist): ${error.message}`);
}

// --- Snapshot de Binance (poblado por scripts/binance-local-poller.mjs) ---
//
// Confirmado con scripts/test-binance-local.mjs: la IP compartida de Render
// está bloqueada por Binance, pero la IP de casa de Daniel funciona sin
// problema. En vez de que el servidor en Render llame a Binance directo
// (imposible mientras esa IP siga bloqueada), un script corriendo en su
// computadora llama a Binance cada 5 minutos y guarda el resultado aquí.
// binance.js, en el servidor, solo LEE este snapshot — nunca llama a
// Binance por su cuenta.

export async function getBinanceSnapshot() {
  const { data, error } = await getClient().from('binance_snapshot').select('*').eq('id', 1).maybeSingle();
  if (error) throw new Error(`Supabase (binance_snapshot): ${error.message}`);
  if (!data) return { balances: [], tickers: {}, balancesUpdatedAt: null, tickersUpdatedAt: null };
  return {
    balances: data.balances || [],
    tickers: data.tickers || {},
    balancesUpdatedAt: data.balances_updated_at,
    tickersUpdatedAt: data.tickers_updated_at,
  };
}

export async function saveBinanceBalancesSnapshot(balances) {
  const { error } = await getClient()
    .from('binance_snapshot')
    .upsert({ id: 1, balances, balances_updated_at: new Date().toISOString() });
  if (error) throw new Error(`Supabase (binance_snapshot balances): ${error.message}`);
}

export async function saveBinanceTickersSnapshot(tickers) {
  const { error } = await getClient()
    .from('binance_snapshot')
    .upsert({ id: 1, tickers, tickers_updated_at: new Date().toISOString() });
  if (error) throw new Error(`Supabase (binance_snapshot tickers): ${error.message}`);
}

// --- Snapshot de cierres diarios (para Reglas con SMA/EMA/RSI) ---
//
// Igual que binance_snapshot: lo llena scripts/binance-local-poller.mjs
// (velas diarias de Binance, mismo motivo — Render no puede llamar a
// Binance directo). Guarda el arreglo de cierres por moneda; el cálculo de
// SMA/EMA/RSI se hace en indicators.js con el período que pida cada regla,
// no se precalculan aquí valores fijos.

export async function getTechnicalSnapshot() {
  const { data, error } = await getClient().from('technical_snapshot').select('*').eq('id', 1).maybeSingle();
  if (error) throw new Error(`Supabase (technical_snapshot): ${error.message}`);
  if (!data) return { closes: {}, updatedAt: null };
  return { closes: data.closes || {}, updatedAt: data.updated_at };
}

export async function saveTechnicalSnapshot(closesByCoin) {
  const { error } = await getClient()
    .from('technical_snapshot')
    .upsert({ id: 1, closes: closesByCoin, updated_at: new Date().toISOString() });
  if (error) throw new Error(`Supabase (technical_snapshot): ${error.message}`);
}

// --- Skills subidas desde el dashboard (sección Skills + IA) ---

export async function getSkills() {
  const { data, error } = await getClient().from('skills').select('*').eq('active', true).order('created_at');
  if (error) throw new Error(`Supabase (skills): ${error.message}`);
  return data || [];
}

export async function saveSkill({ name, description, content }) {
  const { data, error } = await getClient()
    .from('skills')
    .insert({ name, description: description || '', content })
    .select()
    .single();
  if (error) throw new Error(`Supabase (skills): ${error.message}`);
  return data;
}
