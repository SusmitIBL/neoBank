// Starts the mock Bank Portal and the Neobank platform together.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBank } from './bank/server.js';
import { startNeobank } from './neobank/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const NEOBANK_PORT = Number(process.env.NEOBANK_PORT || 3000);
const BANK_PORT = Number(process.env.BANK_PORT || 4000);
const NEOBANK_URL = process.env.NEOBANK_URL || `http://localhost:${NEOBANK_PORT}`;
const BANK_URL = process.env.BANK_URL || `http://localhost:${BANK_PORT}`;
const DATA_DIR = process.env.DATA_DIR || path.join(here, 'data');

let secret = process.env.S2S_SECRET;
if (!secret) {
  secret = 'dev-only-shared-secret-change-me';
  console.warn('⚠  S2S_SECRET not set – using an insecure development secret.');
}

const bank = await startBank({
  port: BANK_PORT,
  publicUrl: BANK_URL,
  neobankUrl: NEOBANK_URL,
  secret,
  dataFile: path.join(DATA_DIR, 'bank.json'),
});
const neobank = await startNeobank({
  port: NEOBANK_PORT,
  publicUrl: NEOBANK_URL,
  bankUrl: BANK_URL,
  secret,
  dataFile: path.join(DATA_DIR, 'neobank.json'),
});

console.log(`NeoBank platform  → ${neobank.url}`);
console.log(`Mock Bank Portal  → ${bank.url}`);
console.log('Delete the data/ folder to reset demo data.');
