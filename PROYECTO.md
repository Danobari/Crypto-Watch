# Gestor de Criptomonedas — Crypto Watch

Este documento define el proyecto en el que se convirtió `crypto-watch`: ya no es solo un dashboard de precios, es un **gestor de criptomonedas** con dos partes trabajando juntas — el sistema y Daniel — cada una con un rol claro y sin superposición.

## División de responsabilidades

**El sistema (automático, corre solo):**
- Sigue el mercado 24/7 según la estrategia definida (ver abajo).
- Calcula en todo momento: cambio % desde tu entrada, precio objetivo en $ del próximo nivel de la escalera, ganancia no tomada desde el pico, y el trailing stop dinámico.
- Avisa por correo cuando una posición cruza un nivel o dispara el trailing stop.
- Sincroniza todo a diario al Google Sheet para tu revisión.
- **Nunca ejecuta órdenes ni mueve fondos.** Todo lo que hace es lectura y cálculo — la API key de Binance conectada solo tiene permiso de lectura.

**Daniel (decide y ejecuta):**
- Revisa las alertas y el dashboard (o el Sheet) cuando le convenga — no hace falta estar pendiente todo el día.
- Decide si coloca la orden sugerida, la ajusta, o la ignora.
- Coloca la orden directamente en Binance (el dashboard da el link directo y la cantidad calculada, pero el clic final siempre es tuyo).
- Registra el resultado en el dashboard: marca el nivel como vendido, actualiza precio de entrada cuando entra una posición nueva (ej. al mover cripto de Ledger a Binance), agrega/quita monedas de la watchlist.

## La estrategia (bloques de la escalera)

Cada posición pertenece a un bloque, y cada bloque tiene su propio ritmo de toma de ganancias:

| Bloque | Monedas actuales | Niveles (% desde entrada → % a vender) | Objetivo |
|---|---|---|---|
| **Core** | BTC, ETH | +50% → 20% · +100% → 20% · +150% → trailing stop | Base del portafolio — más margen antes de vender, se deja correr más. |
| **Rotación** | XRP | +40% → 20% · +80% → 20% · +120% → trailing stop | Candidato principal para rotar capital hacia BTC/ETH/stables. |
| **Experimental** | ALGO, XLM | +25% → 25% · +50% → 25% · +75% → trailing stop | Recuperar capital rápido — toma de ganancias más agresiva. |

Después del último nivel de cada bloque, ya no hay ventas automáticas por %: se arma un **trailing stop dinámico** (ATR de 14 días × un multiplicador que depende de la fase de ciclo que reportes manualmente en la pestaña Ciclo de Mercado — más ceñido en euforia/distribución, más holgado en acumulación/bajista). El CBBI (score 0-100 de 9 indicadores on-chain) se muestra ahí mismo como referencia, pero nunca dispara nada por sí solo.

## Estado actual (lo que ya está construido)

- **Infraestructura estable**: dashboard en Render (24/7, gratis), datos de Binance vía un poller que corre en tu Mac (evita el bloqueo de IP compartida de Render), snapshot en Supabase, sincronización diaria a Google Sheets.
- **Acceso protegido**: login propio con usuario/contraseña (ya no el cuadro genérico del navegador).
- **Cartera accionable**: precio objetivo en $ por nivel (no solo %), modal de detalle consolidado por posición (clic en el nombre de la moneda), ganancia no tomada desde el pico registrado.
- **Mercado (Tracker)**: watchlist con BTC/ETH/XLM/ALGO + agregar/quitar monedas con autocompletado por nombre.
- **Google Sheet**: mismas columnas que el dashboard, incluyendo precio objetivo, pico y ganancia no tomada.

## Auditoría: ajustes de la estrategia pendientes

Esto es lo que quedó anotado en su momento como "siguientes pasos" y sigue sin implementarse. Aviso: no tengo acceso al texto exacto de esa conversación (quedó fuera del historial que puedo releer), así que esta lista sale de revisar el código actual contra esas notas — si me faltó algo que platicamos, dímelo y lo agrego.

- **Más tipos de condición en Reglas** — hoy solo evalúa precio absoluto y % de cambio en 24h. Si tu estrategia necesita medias móviles, RSI o volumen, falta construirlo.
- **Canal de aviso alterno** — hoy todo llega por correo (Gmail). Telegram/WhatsApp/Slack seguiría pendiente si lo quieres.
- **Indicadores CBBI individuales** — hoy solo se usa el score agregado (0-100). Los 9 indicadores por separado (Pi Cycle Top, Puell, MVRV Z-Score, etc.) no se traen todavía.
- **Resumen semanal con IA** — la sección de "Skills + API key de IA" en el dashboard sigue pendiente (tarea #27 de la lista de trabajo).
- **Encontré algo que revisar**: hay una regla activa en el sistema para "BTC por debajo de $2000" — con BTC en ~$64k parece un residuo de cuando se probó el sistema. Confírmame si la elimino o si es intencional.

## Lo que sigue

La lista de tareas de este proyecto (visible en el panel de tareas de esta sesión) tiene el detalle línea por línea de lo hecho y lo pendiente. Los 4 puntos de la auditoría de arriba están ya cargados ahí como tareas nuevas — dime en qué orden quieres atacarlos, o si alguno no aplica.
