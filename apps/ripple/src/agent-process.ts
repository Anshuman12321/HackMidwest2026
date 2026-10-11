import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export type AgentContext = { workspace: string; actor_id: string; actor_session_token: string };
export class BridgeError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
/** Private server-side protocol. Credentials travel over stdin, never argv or UI. */
export function runAgentBridge(operation: string, payload: unknown, context?: AgentContext, local = false): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.RIPPLE_PYTHON ?? 'python3', [fileURLToPath(new URL('../../../scripts/agent_bridge.py', import.meta.url))],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; let size = 0, settled = false;
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve(result);
    };
    const timer = setTimeout(() => finish(new BridgeError('blocked', 'The read-only investigation timed out. Retry the review.')), 55_000);
    child.on('error', () => finish(new BridgeError('blocked', 'Configure RIPPLE_PYTHON with Python 3.11 or newer.')));
    child.stdin.on('error', () => finish(new BridgeError('blocked', 'The read-only investigation process stopped.')));
    child.stderr.on('data', () => { /* Never expose process diagnostics or credential-bearing responses. */ });
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) return finish(new BridgeError('blocked', 'The investigation exceeded its bounded response size.'));
      chunks.push(chunk);
    });
    child.on('close', code => {
      if (settled) return;
      try {
        const reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (reply.ok !== true) {
          const allowed = ['permission_denied', 'evidence_changed', 'invalid_request', 'blocked'];
          const failure = allowed.includes(reply.error?.code) ? reply.error.code : 'blocked';
          return finish(new BridgeError(failure, failure === 'permission_denied' ? 'Current DevRev access was denied.' :
            failure === 'evidence_changed' ? 'The reviewed evidence changed. Start a fresh investigation.' : 'The read-only investigation could not complete.'));
        }
        if (code !== 0) throw new Error('Process failed');
        finish(undefined, reply.result);
      } catch { finish(new BridgeError('blocked', 'The investigation process returned an invalid response.')); }
    });
    child.stdin.end(JSON.stringify({ operation, payload, context, local }));
  });
}
