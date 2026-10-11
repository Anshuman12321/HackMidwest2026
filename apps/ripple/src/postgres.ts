import pg from 'pg';
import type { Database, SQL } from './store.ts';
export class Postgres implements Database {
  pool: pg.Pool;
  schema?: string;
  constructor(connectionString: string, schema?: string, options: { ca?: string; max?: number } = {}) {
    if (schema !== undefined && !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid Postgres schema name.');
    this.schema = schema;
    if (options.ca) { // URL sslmode/sslrootcert parameters would override the explicit CA below.
      try { const u = new URL(connectionString); for (const k of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']) u.searchParams.delete(k); connectionString = u.href; }
      catch { /* Leave unparseable strings to pg to report. */ }
    }
    this.pool = new pg.Pool({ connectionString, max: options.max ?? 10,
      ...(options.ca ? { ssl: { ca: options.ca, rejectUnauthorized: true } } : {}) });
  }
  async connection<T>(fn: (sql: SQL) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let releaseError: Error | undefined;
    try {
      if (this.schema) await client.query('SET search_path TO "' + this.schema + '"');
      return await fn({ query: async (sql, values) => client.query(sql, values) });
    } finally {
      if (this.schema) {
        try { await client.query('RESET search_path'); }
        catch (error) { releaseError = error instanceof Error ? error : new Error(String(error)); }
      }
      client.release(releaseError);
    }
  }
}
