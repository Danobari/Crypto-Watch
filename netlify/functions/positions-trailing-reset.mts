import { getPosition, savePosition } from '../../db.js';
import { json, jsonError } from './_shared/http.mts';

// POST /api/positions/:coin/trailing-stop/reset
export default async (req, context) => {
  try {
    const { coin } = context.params;
    const position = await getPosition(coin);
    if (!position) return json({ error: 'Posición no encontrada' }, 404);
    position.trailingStop = { armed: false, peakPrice: null, atr: null, multiplier: null, stopPrice: null, triggered: false };
    await savePosition(position);
    return json(position);
  } catch (e) {
    return jsonError(e);
  }
};

export const config = {
  path: '/api/positions/:coin/trailing-stop/reset',
};
