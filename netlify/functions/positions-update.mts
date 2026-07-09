import { getPosition, savePosition } from '../../db.js';
import { json, jsonError } from './_shared/http.mts';

// PUT /api/positions/:coin — editar precio de entrada, bloque, notas, niveles.
export default async (req, context) => {
  try {
    const { coin } = context.params;
    const position = await getPosition(coin);
    if (!position) return json({ error: 'Posición no encontrada' }, 404);
    const body = await req.json();
    const updated = { ...position, ...body, coin: position.coin };
    await savePosition(updated);
    return json(updated);
  } catch (e) {
    return jsonError(e);
  }
};

export const config = {
  path: '/api/positions/:coin',
};
