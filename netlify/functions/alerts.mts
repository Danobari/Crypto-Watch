import { getAlertsLog } from '../../db.js';
import { json, jsonError } from './_shared/http.mts';

// GET /api/alerts — historial de alertas ya disparadas.
export default async (req) => {
  try {
    const log = await getAlertsLog();
    return json(log);
  } catch (e) {
    return jsonError(e);
  }
};

export const config = {
  path: '/api/alerts',
};
