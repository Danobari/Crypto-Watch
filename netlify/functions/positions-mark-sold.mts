import { getPosition, savePosition } from '../../db.js';
import { json, jsonError } from './_shared/http.mts';

// POST /api/positions/:coin/levels/:levelIndex/mark-sold
export default async (req, context) => {
  try {
    const { coin, levelIndex } = context.params;
    const position = await getPosition(coin);
    if (!position) return json({ error: 'Posición no encontrada' }, 404);
    const level = position.levels[Number(levelIndex)];
    if (!level) return json({ error: 'Nivel no encontrado' }, 404);
    const body = await req.json().catch(() => ({}));
    level.sold = body.sold !== undefined ? !!body.sold : true;
    level.soldAt = level.sold ? new Date().toISOString() : null;
    await savePosition(position);
    return json(position);
  } catch (e) {
    return jsonError(e);
  }
};

export const config = {
  path: '/api/positions/:coin/levels/:levelIndex/mark-sold',
};
