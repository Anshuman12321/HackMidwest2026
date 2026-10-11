import { Postgres } from './postgres.ts';
import { Store } from './store.ts';
import { Secrets } from './security.ts';
import { DevRevGateway, AgentClient } from './native.ts';
import { mcpOwnerSearch } from './mcp.ts';
import { RippleService } from './service.ts';
import { Controller } from './controller.ts';
import { server } from './http.ts';
const env = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`Configure ${name} before starting Ripple.`); return value; };
const actors = new Set(env('RIPPLE_ACTOR_IDS').split(',').filter(Boolean));
const owners = new Set(env('RIPPLE_ASSIGNABLE_OWNER_IDS').split(',').filter(Boolean));
const db = new Postgres(env('DATABASE_URL'));
const native = new DevRevGateway({ workspace: env('DEVREV_WORKSPACE_ID'), actors, owners }, mcpOwnerSearch(env('DEVREV_MCP_URL')));
const service = new RippleService(new Store(db), native, new AgentClient(env('AGENT_URL'), env('AGENT_BEARER')), new Secrets(env('RIPPLE_SECRET')));
const publicUrl = env('RIPPLE_PUBLIC_URL');
if (!publicUrl.startsWith('https://') && !publicUrl.startsWith('http://127.0.0.1:')) throw new Error('RIPPLE_PUBLIC_URL must use HTTPS.');
const app = server(new Controller(service, publicUrl));
app.listen(Number(process.env.PORT ?? 8787), process.env.HOST ?? '127.0.0.1', () => console.log('Ripple service listening.'));
let busy = false;
const timer = setInterval(async () => {
  if (busy) return; busy = true;
  try { await service.workOnce(); } catch { console.error('Ripple worker failed; durable jobs will be resumed.'); }
  finally { busy = false; }
}, 1000);
const stop = () => { clearInterval(timer); app.close(() => { void db.pool.end(); }); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
