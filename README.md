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

## Siguientes pasos con Claude Code o Codex

Este es un punto de partida funcional, no el proyecto terminado. Cosas
razonables para pedirle a Claude Code o Codex desde aquí:

- Revisar y ajustar `data/rules.json` con el resto de tu estrategia.
- Agregar más tipos de condición si tu estrategia los necesita (medias
  móviles, RSI, volumen, etc. — hoy solo cubre precio y cambio 24h).
- Cambiar el canal de aviso (Telegram, WhatsApp, Slack) si prefieres algo
  distinto a correo.
- Ponerlo a correr de forma permanente en tu máquina o en un servidor.
- Agregar una vista web simple para ver el registro de avisos sin tener que
  abrir `data/alerts-log.json` a mano.

## Seguridad

- `.env` nunca se sube a ningún repositorio (ya está en `.gitignore`).
- La API key de Binance debe quedarse en modo lectura para siempre. Si algún
  día quieres automatizar la ejecución, ese es un cambio deliberado y
  riesgoso — no algo que deba pasar por accidente.
