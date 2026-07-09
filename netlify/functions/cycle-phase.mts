import { saveCyclePhase } from '../../db.js';
import { json, jsonError } from './_shared/http.mts';

const VALID_PHASES = ['acumulacion', 'alcista_temprano', 'neutral', 'euforia', 'distribucion', 'bajista'];

// PUT /api/cycle-phase — fase de ciclo manual (ej. la lectura de tu GPT).
export default async (req) => {
  try {
    const body = await req.json();
    const phase = VALID_PHASES.includes(body.phase) ? body.phase : 'neutral';
    const payload = await saveCyclePhase({ phase, notes: body.notes, source: body.source });
    return json(payload);
  } catch (e) {
    return jsonError(e);
  }
};

export const config = {
  path: '/api/cycle-phase',
};
