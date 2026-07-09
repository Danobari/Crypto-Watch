# crypto-watch

Monitorea tus posiciones reales en Binance y tus reglas de precio, y te avisa
por correo con una orden ya calculada — cantidad, lado, valor aproximado —
para que tú la coloques a mano. **Nunca coloca ni ejecuta operaciones.**

Corre solo, en segundo plano, aunque no tengas nada abierto en la
computadora ni el navegador. Esa es la diferencia frente al panel de chat:
aquí sí puede avisarte a las 3am si algo se dispara.

## Qué SÍ hace

- Lee tus saldos reales de Binance (solo lectura).
- Revisa el precio y el cambio 24h de los activos en tus reglas.
- Evalúa tus reglas (ya definidas por ti en `data/rules.json`).
- Cuando una regla se cumple, calcula la orden sugerida según el tamaño que
  tú configuraste (% de tu posición, monto fijo en USD, o cantidad fija).
- Te manda un correo con el aviso y la orden sugerida.
- Guarda un registro local en `data/alerts-log.json`.

## Qué NO hace

- No coloca órdenes en Binance.
- No tiene ni necesita permiso de trading ni de retiros.
- No decide tu estrategia — solo hace la aritmética sobre las reglas que tú
  definas.

## 1. Crear la API key de Binance (solo lectura)

1. Entra a Binance → perfil → **API Management** → Create API.
2. En los permisos de la key, deja activado **únicamente** "Enable Reading".
3. Deja **desactivados** "Enable Spot & Margin Trading", "Enable Withdrawals"
   y "Enable Futures". Con esto, aunque la key se filtre, no se puede
   colocar una orden ni mover un centavo.
4. Si Binance te lo permite, restringe la key a la IP de la máquina donde
   vas a correr esto.
5. Copia la API key y el secreto — el secreto solo se muestra una vez.

## 2. Configurar el correo de avisos

1. En tu cuenta de Gmail, genera una contraseña de aplicación:
   https://myaccount.google.com/apppasswords
2. Esa contraseña (no la de tu cuenta) va en `GMAIL_APP_PASSWORD`.

## 3. Instalar y configurar

```bash
cp .env.example .env
# Edita .env con tu API key/secret de Binance y tus datos de Gmail

cp config/rules.example.json data/rules.json
# Edita data/rules.json con tus reglas reales

npm install
npm start
```

## 4. Dejarlo corriendo de forma permanente

`npm start` corre en primer plano. Para que siga corriendo aunque cierres
la terminal, algunas opciones simples:

- **pm2**: `npm install -g pm2` y luego `pm2 start src/index.js --name crypto-watch`
- **macOS (launchd)**: crear un `.plist` que corra `npm start` al iniciar sesión
- Un VPS pequeño (Railway, Fly.io, una Raspberry Pi en casa) si prefieres que
  no dependa de que tu computadora esté encendida

## Cartera (data/positions.json)

Esta es la pieza central: reemplaza al Tracker.xlsx manual. Cada posición
tiene tu precio de entrada real, un bloque (`core` / `rotation` /
`experimental`) y una escalera de niveles de toma de ganancias con su %
de venta sugerido. La pestaña **Cartera** del dashboard calcula en vivo,
por posición: precio actual, % de cambio desde tu entrada, valor actual,
% ya vendido y la próxima acción — sin que tengas que calcular nada a mano.

Los bloques traen niveles distintos por defecto (puedes ajustarlos editando
`data/positions.json` o vía `PUT /api/positions/:coin`):

- **Core** (BTC, ETH): +50% / +100% / +150% — se les da más margen.
- **Rotación** (ej. XRP): +40% / +80% / +120% — el esquema original.
- **Experimental** (ej. ALGO, XLM): +25% / +50% / +75% — toma de ganancias
  más rápida.

El último nivel de cada escalera nunca vende automáticamente — el
sistema solo te recuerda evaluar un trailing stop dinámico (ATR) en vez de
un porcentaje fijo, tal como se acordó en la estrategia.

Cuando el precio cruza un nivel no vendido, `crypto-watch` te manda el
mismo correo de siempre y además queda visible en el dashboard con un
botón **Preparar Orden**: calcula cantidad, símbolo, valor aproximado y una
reserva orientativa para impuestos, te deja copiar la cantidad al
portapapeles y abre el par correspondiente en Binance para que la coloques
tú mismo. **Nunca coloca la orden — solo prepara los números.** Cuando la
ejecutes, marca el nivel como "vendido" en el dashboard para que no te
vuelva a avisar de lo mismo.

## Trailing Stop Dinámico (ATR)

Cuando el precio de una posición cruza el último nivel de su escalera (el
que dice "no vender automático"), el sistema arma un trailing stop basado
en ATR14 (rango real promedio de 14 días, con el suavizado de Wilder — el
estándar para esto) en vez de un porcentaje fijo:

```
stop = máximo de precio alcanzado − (ATR14 × multiplicador)
```

El multiplicador depende de la fase de ciclo que definas en la pestaña
**Ciclo de Mercado** (ver abajo): más ceñido en Euforia/Distribución
(protege más rápido), más holgado en Acumulación (deja correr más). El ATR
se recalcula como máximo cada 12 horas para no golpear la API de Binance
sin necesidad.

Cuando el precio cae por debajo del stop, te llega el correo de siempre y
en el dashboard aparece un botón para preparar la orden de salida (mismo
patrón que los niveles: cantidad, valor, link a Binance, copiar cantidad).
**Sigue sin colocar nada — solo avisa y calcula.** Una vez ejecutes la
venta, hay un botón para reiniciar el trailing stop de esa posición.

## Ciclo de Mercado

Pestaña con dominancia de BTC, el ratio ETH/BTC (fuente: CoinGecko +
Binance) y el score agregado **CBBI** (ColinTalksCrypto Bitcoin Bull Run
Index, `colintalkscrypto.com/cbbi` — 9 indicadores on-chain combinados en
un solo número de 0 a 100, gratis y de código abierto). El CBBI es
puramente informativo: nunca dispara nada por sí solo, solo te da una
segunda opinión cuantitativa junto a tu análisis cualitativo. Incluye
también un link directo al índice de Altseason completo — el cálculo real
de ese índice (90 días, top 100 monedas) no se replica aquí, solo se
linkea.

Además hay un campo de **fase de ciclo manual**: aquí pegas la lectura de
tu GPT de indicadores on-chain (Pi Cycle Top, Puell, MVRV Z-Score, NUPL,
RHODL, Reserve Risk, 2Y MA Multiplier, Mayer, Golden Ratio) como una de
seis fases (Acumulación / Alcista temprano / Neutral / Euforia /
Distribución / Bajista). Esa fase es la que ajusta el multiplicador del
trailing stop de todas tus posiciones — es la forma en que ese análisis
más profundo se conecta con la parte automática del dashboard, sin tener
que recalcular los 9 indicadores aquí.

## Siguientes pasos con Claude Code o Codex

Este es un punto de partida funcional, no el proyecto terminado. Cosas
razonables para pedirle a Claude Code o Codex desde aquí:

- Revisar y ajustar `data/rules.json` y `data/positions.json` con el resto
  de tu estrategia.
- Agregar más tipos de condición si tu estrategia los necesita (medias
  móviles, RSI, volumen, etc. — hoy solo cubre precio, cambio 24h y % desde
  tu entrada).
- Traer automáticamente más de los 9 indicadores del CBBI de forma
  individual (hoy solo se usa el score agregado), si quieres el detalle de
  cada uno en vez de solo el número final.
- Cambiar el canal de aviso (Telegram, WhatsApp, Slack) si prefieres algo
  distinto a correo.
- Ponerlo a correr de forma permanente en tu máquina o en un servidor.
- Si agregas una API de OpenAI, un buen primer uso es generar un resumen en
  lenguaje natural de la revisión semanal (viernes) a partir de
  `/api/portfolio` y `/api/cycle`, en vez de tener que interpretar los
  números tú mismo.

## Seguridad

- `.env` nunca se sube a ningún repositorio (ya está en `.gitignore`).
- La API key de Binance debe quedarse en modo lectura para siempre. Si algún
  día quieres automatizar la ejecución, ese es un cambio deliberado y
  riesgoso — no algo que deba pasar por accidente.
