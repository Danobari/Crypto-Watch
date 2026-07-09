// Helper compartido por las funciones de Netlify: mismas respuestas JSON
// que ya devolvía server.js (Express), para que public/app.js no tenga que
// cambiar ni una línea.

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function jsonError(error, status = 500) {
  return json({ error: error.message || String(error) }, status);
}
