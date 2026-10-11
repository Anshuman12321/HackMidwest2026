import pg from 'pg';
import type { Database, SQL } from './store.ts';
export class Postgres implements Database {
  pool: pg.Pool;
  constructor(connectionString: string) { this.pool = new pg.Pool({ connectionString, max: 10 }); }
  async connection<T>(fn: (sql: SQL) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { return await fn({ query: async (sql, values) => client.query(sql, values) }); }
    finally { client.release(); }
  }
}
