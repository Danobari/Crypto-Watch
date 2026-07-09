import crypto from 'node:crypto';
import { getRules, addRule } from '../../db.js';
import { json, jsonError } from './_shared/http.mts';

// GET /api/rules — lista de reglas. POST /api/rules — crear una nueva.
// (El DELETE /api/rules/:id vive en rules-delete.mts, path distinto.)
export default async (req) => {
  try {
    if (req.method === 'POST') {
      const body = await req.json();
      const newRule = {
        id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 9),
        active: true,
        ...body,
      };
      const saved = await addRule(newRule);
      return json(saved);
    }
    const rules = await getRules();
    return json(rules);
  } catch (e) {
    return jsonError(e);
  }
};

export const config = {
  path: '/api/rules',
};
