import { createAgentServer } from './agent-http.ts';
const bearer = process.env.AGENT_BEARER;
if (!bearer) throw new Error('Configure AGENT_BEARER before starting the agent.');
const app = createAgentServer({ bearer });
app.listen(Number(process.env.AGENT_PORT ?? 8790), process.env.AGENT_HOST ?? '127.0.0.1', () => console.log('Ripple v2 read-only agent listening.'));
process.on('SIGTERM', () => app.close());
process.on('SIGINT', () => app.close());
