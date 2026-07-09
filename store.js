import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = path.resolve('./data');

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function readJSON(filename, fallback) {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, filename), 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

export async function writeJSON(filename, data) {
  await ensureDataDir();
  await fs.writeFile(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2));
}
