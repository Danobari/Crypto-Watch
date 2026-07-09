-- Esquema de Supabase para crypto-watch.
-- Reemplaza los archivos data/*.json por tablas reales, para poder correr
-- el servidor en la nube (los archivos locales no persisten bien entre
-- despliegues en la mayoría de hostings).
--
-- Cómo aplicar: Supabase → tu proyecto → SQL Editor → pega este archivo →
-- Run. Es seguro correrlo más de una vez (usa IF NOT EXISTS).

-- Cartera: una fila por posición (BTC, ETH, XRP...). "levels" y
-- "trailing_stop" quedan como JSONB porque su forma interna (niveles,
-- estado del trailing stop) es la misma que ya usa el código en
-- positions.json — así el refactor de store.js es mínimo.
create table if not exists positions (
  coin text primary key,
  block text not null default 'core' check (block in ('core', 'rotation', 'experimental')),
  entry_price numeric not null,
  notes text default '',
  levels jsonb not null default '[]'::jsonb,
  trailing_stop jsonb default null,
  trailing_sell_pct numeric default 100,
  updated_at timestamptz not null default now()
);

-- Fase de ciclo manual (la lectura de tu GPT de indicadores on-chain).
-- Solo debería tener una fila; se actualiza siempre la misma.
create table if not exists cycle_phase (
  id int primary key default 1,
  phase text not null default 'neutral'
    check (phase in ('acumulacion','alcista_temprano','neutral','euforia','distribucion','bajista')),
  notes text default '',
  source text default 'manual',
  updated_at timestamptz not null default now(),
  constraint single_row check (id = 1)
);
insert into cycle_phase (id, phase, notes) values (1, 'neutral', 'Sin actualizar todavía.')
  on conflict (id) do nothing;

-- Reglas ad-hoc de precio/% (lo que ya vivía en rules.json).
create table if not exists rules (
  id text primary key,
  coin text not null,
  type text not null check (type in ('above','below','change_up','change_down')),
  value numeric not null,
  active boolean not null default true,
  order_config jsonb, -- { side, sizeType, sizeValue }
  created_at timestamptz not null default now()
);

-- Historial de avisos ya enviados (alerts-log.json). Con índice por fecha
-- porque esta tabla va a crecer indefinidamente si no la limpiamos.
create table if not exists alerts_log (
  id bigint generated always as identity primary key,
  rule_id text,
  message text not null,
  created_at timestamptz not null default now()
);
create index if not exists alerts_log_created_at_idx on alerts_log (created_at desc);

-- Estado de qué niveles/reglas ya dispararon aviso, para no repetir el
-- mismo correo cada ciclo (triggered.json).
create table if not exists triggered_state (
  key text primary key,
  triggered boolean not null default true,
  updated_at timestamptz not null default now()
);

-- Skills subidas desde el dashboard (sección Skills + IA). El contenido en
-- markdown se guarda tal cual; el dashboard se lo pasa al proveedor de IA
-- elegido (Anthropic/OpenAI) como instrucciones para tareas puntuales.
-- La API key del proveedor NO va aquí — vive como variable de entorno del
-- servidor, nunca en la base de datos ni en el frontend.
create table if not exists skills (
  id bigint generated always as identity primary key,
  name text not null,
  description text default '',
  content text not null, -- el markdown completo
  active boolean not null default true,
  created_at timestamptz not null default now()
);
