import { deleteRule } from '../../db.js';
import { json, jsonError } from './_shared/http.mts';

// DELETE /api/rules/:id
export default async (req, context) => {
  try {
    await deleteRule(context.params.id);
    return json({ success: true });
  } catch (e) {
    return jsonError(e);
  }
};

export const config = {
  path: '/api/rules/:id',
};
