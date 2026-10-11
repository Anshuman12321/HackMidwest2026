import { readFileSync } from 'node:fs';
import { Postgres } from './postgres.ts';
if (!process.env.DATABASE_URL) throw new Error('Configure DATABASE_URL.');
const db = new Postgres(process.env.DATABASE_URL);
try { await db.connection(sql => sql.query(readFileSync(new URL('../migrations/001_ripple.sql', import.meta.url), 'utf8'))); console.log('Ripple migration applied.'); }
finally { await db.pool.end(); }
