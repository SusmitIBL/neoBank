// Tiny JSON-file store. Good enough for a mock; swap for PostgreSQL in production.
import fs from 'node:fs';
import path from 'node:path';

export function createStore(file, seed) {
  let data;
  if (file && fs.existsSync(file)) {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    data = seed();
  }

  function save() {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  save();
  return { data, save };
}

// Append-only audit trail entry.
export function audit(store, actor, action, details = {}) {
  store.data.audit.push({ at: new Date().toISOString(), actor, action, details });
  if (store.data.audit.length > 5000) store.data.audit.splice(0, store.data.audit.length - 5000);
}
