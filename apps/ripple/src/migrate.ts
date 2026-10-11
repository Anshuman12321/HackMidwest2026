import { readFileSync, readdirSync } from 'node:fs';
import { Postgres } from './postgres.ts';
if (!process.env.DATABASE_URL) throw new Error('Configure DATABASE_URL.');
const db = new Postgres(process.env.DATABASE_URL);
try {
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(file => file.endsWith('.sql')).sort())
    await db.connection(sql => sql.query(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8')));
  console.log('Ripple migrations applied.');
}
finally { await db.pool.end(); }
