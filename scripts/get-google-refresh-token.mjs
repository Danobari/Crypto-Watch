// Genera un refresh_token de Google (una sola vez) para que la función de
// Netlify pueda escribir en tu Google Sheet en tu nombre, sin usar una
// cuenta de servicio (bloqueada por la política de tu organización).
//
// Uso:
//   1. Rellena CLIENT_ID y CLIENT_SECRET abajo con los que copiaste de
//      Google Cloud Console (Credenciales → tu OAuth Client ID de tipo
//      "Aplicación de escritorio").
//   2. Corre:  node scripts/get-google-refresh-token.mjs
//   3. Se abre (o te da un link para abrir) tu navegador — inicia sesión
//      con lat.daniiels05@gmail.com y acepta el permiso de Sheets.
//   4. El script captura el código automáticamente y te imprime el
//      refresh_token en la terminal. Pásame ese valor junto con el
//      CLIENT_ID y CLIENT_SECRET — con eso configuro las env vars en
//      Netlify. Este script no envía nada a nadie más que a Google.

import http from 'node:http';
import https from 'node:https';

const CLIENT_ID = 'PON_AQUI_TU_CLIENT_ID';
const CLIENT_SECRET = 'PON_AQUI_TU_CLIENT_SECRET';

const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

if (CLIENT_ID.startsWith('PON_AQUI') || CLIENT_SECRET.startsWith('PON_AQUI')) {
  console.error('Primero edita este archivo y pon tu CLIENT_ID y CLIENT_SECRET reales.');
  process.exit(1);
}

const authUrl =
  `https://accounts.google.com/o/oauth2/v2/auth?` +
  `client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPE)}` +
  `&access_type=offline` +
  `&prompt=consent`;

console.log('\nAbre este link en tu navegador (inicia sesión con lat.daniiels05@gmail.com):\n');
console.log(authUrl);
console.log('\nEsperando a que aceptes el permiso...\n');

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/oauth2callback')) {
    res.writeHead(404);
    res.end();
    return;
  }
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<h2>Error: ${error}</h2><p>Puedes cerrar esta pestaña.</p>`);
    console.error('Google devolvió un error:', error);
    server.close();
    process.exit(1);
  }

  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<h2>Listo — ya puedes cerrar esta pestaña.</h2>');

  try {
    const tokens = await exchangeCodeForTokens(code);
    console.log('\n--- Copia esto y pásaselo a Claude ---');
    console.log('CLIENT_ID:', CLIENT_ID);
    console.log('CLIENT_SECRET:', CLIENT_SECRET);
    console.log('REFRESH_TOKEN:', tokens.refresh_token);
    console.log('---------------------------------------\n');
  } catch (e) {
    console.error('No se pudo obtener el refresh token:', e.message);
  } finally {
    server.close();
    process.exit(0);
  }
});

server.listen(PORT);

function exchangeCodeForTokens(code) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    }).toString();

    const req = https.request(
      'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) return reject(new Error(parsed.error_description || parsed.error));
            resolve(parsed);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
