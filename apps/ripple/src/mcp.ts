import { RippleError } from './types.ts';
import type { Auth } from './types.ts';
// Optional deployment connection: use a caller-delegated DevRev MCP endpoint.
// Never reuse a developer's personal connector bearer token for another actor.
export function mcpOwnerSearch(url: string) {
  if (!url.startsWith('https://')) throw new Error('DEVREV_MCP_URL must use HTTPS.');
  const checked = new Set<string>();
  return async (auth: Auth, query: string): Promise<string[]> => {
    let session: string | null = null;
    const rpc = async (method: string, params: unknown, id?: number): Promise<any> => {
      const response = await fetch(url, { method: 'POST', headers: {
        Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-03-26', ...(session ? { 'Mcp-Session-Id': session } : {}),
      }, body: JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, params }), signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new RippleError('permission_denied', 'The actor-scoped DevRev MCP connection failed.');
      session = response.headers.get('Mcp-Session-Id') ?? session;
      if (!id) return null;
      const raw = await response.text();
      const message = response.headers.get('content-type')?.includes('text/event-stream')
        ? raw.split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5))).find(v => v.id === id)
        : JSON.parse(raw);
      if (message?.error || !message?.result) throw new RippleError('invalid_response', 'DevRev MCP returned an invalid response.');
      return message.result;
    };
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ripple', version: '2.0.0' } }, 1);
    await rpc('notifications/initialized', {});
    const listed = await rpc('tools/list', {}, 2);
    const tool = listed.tools?.find((t: any) => /(^|__)hybrid_search$/.test(t.name));
    if (!tool || !tool.inputSchema?.properties?.namespace) throw new RippleError('blocked', 'This MCP connection does not expose owner search.');
    const unpack = (r: any) => {
      if (r.isError) throw new RippleError('blocked', 'DevRev schema discovery or owner search failed.');
      return r.structuredContent ?? JSON.parse(r.content?.find((c: any) => c.type === 'text')?.text ?? '{}');
    };
    if (!checked.has(auth.workspace)) {
      const discover = listed.tools?.find((t: any) => /(^|__)discover_schema$/.test(t.name));
      if (!discover) throw new RippleError('blocked', 'This MCP connection cannot discover ticket schemas.');
      unpack(await rpc('tools/call', { name: discover.name, arguments: {} }, 3));
      const create = unpack(await rpc('tools/call', { name: discover.name, arguments: { action_name: 'create_ticket' } }, 4));
      const lookup = unpack(await rpc('tools/call', { name: discover.name, arguments: { action_name: 'list_tickets' } }, 5));
      const expected = ['title', 'body', 'applies_to_part', 'owned_by', 'visibility', 'external_ref'];
      if (!expected.every(k => create.properties?.[k]) || !create.properties.visibility.enum?.includes(1) || !lookup.properties?.external_ref ||
        (create.required ?? []).some((k: string) => !expected.includes(k)))
        throw new RippleError('blocked', 'Workspace ticket fields differ from the reviewed adapter. Update the contract before writing.');
      checked.add(auth.workspace);
    }
    const result = await rpc('tools/call', { name: tool.name, arguments: { namespace: 'dev_user',
      query: `Which current DevRev users match ${query || 'the current workspace members'}?`, projection_type: 'id_with_label', limit: 20 } }, 6);
    const value = unpack(result);
    return (value.results ?? []).map((r: any) => r.id).filter((id: any) => typeof id === 'string');
  };
}
