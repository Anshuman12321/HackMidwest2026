"""Local MCP bridge. Credentials remain in memory; no DevRev REST calls.

Read tool allowlist is reviewed after discovery; source text cannot select tools.
"""
import json
import os
import pathlib
import sys
import tomllib
import urllib.request

READ_TOOLS = {'discover_schema', 'hybrid_search', 'fetch_object_context', 'execute_dql'}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward the credential to a redirect destination.
        raise ValueError('Authenticated MCP redirects are not supported')


class DevRevMCP:
    def __init__(self):
        config = pathlib.Path(os.environ.get('CODEX_HOME', pathlib.Path.home() / '.codex')) / 'config.toml'
        server = tomllib.loads(config.read_text(encoding='utf-8-sig'))['mcp_servers']['DevRev']
        self.url = server['url']
        if self.url != 'https://api.devrev.ai/mcp/v1':
            raise ValueError('This adapter is restricted to the reviewed DevRev MCP endpoint')
        self.headers = dict(server.get('http_headers', {}))
        if server.get('bearer_token_env_var'):
            self.headers['Authorization'] = 'Bearer ' + os.environ[server['bearer_token_env_var']]
        for header, variable in server.get('env_http_headers', {}).items():
            self.headers[header] = os.environ[variable]
        self.headers.update({'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'})
        self.opener = urllib.request.build_opener(NoRedirect())
        self.counter = 0
        result = self.rpc('initialize', {'protocolVersion': '2025-03-26', 'capabilities': {},
                                        'clientInfo': {'name': 'ripple-readonly', 'version': '1.0.0'}})
        self.headers['MCP-Protocol-Version'] = result['protocolVersion']
        self.rpc('notifications/initialized', {}, notification=True)

    def rpc(self, method, params, notification=False):
        self.counter += 1
        payload = {'jsonrpc': '2.0', 'method': method, 'params': params}
        if not notification:
            payload['id'] = self.counter
        request = urllib.request.Request(self.url, data=json.dumps(payload).encode(), headers=self.headers, method='POST')
        with self.opener.open(request, timeout=60) as response:
            session = response.headers.get('Mcp-Session-Id')
            if session:
                self.headers['Mcp-Session-Id'] = session
            if notification:
                return None
            if 'text/event-stream' in response.headers.get('Content-Type', ''):
                data = []
                for raw in response:
                    line = raw.decode('utf-8').rstrip('\r\n')
                    if line.startswith('data:'):
                        data.append(line[5:].lstrip())
                    elif not line and data:
                        message = json.loads('\n'.join(data)); data = []
                        if message.get('id') == payload['id']:
                            break
                else:
                    raise ValueError('MCP stream ended without a matching response')
            else:
                message = json.load(response)
        if message.get('id') != payload['id'] or 'error' in message:
            raise ValueError('MCP RPC rejected or mismatched response')
        return message['result']

    def discover(self):
        result = self.rpc('tools/list', {})
        tools = list(result['tools'])
        while result.get('nextCursor'):
            result = self.rpc('tools/list', {'cursor': result['nextCursor']})
            tools.extend(result['tools'])
        return tools

    def call(self, name, arguments):
        if name not in READ_TOOLS:
            raise ValueError('Tool outside read-only allowlist')
        result = self.rpc('tools/call', {'name': name, 'arguments': arguments})
        if result.get('isError'):
            raise ValueError('MCP read tool returned an error')
        if 'structuredContent' in result:
            return result['structuredContent']
        texts = [item['text'] for item in result.get('content', []) if item['type'] == 'text']
        text = '\n'.join(texts)
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return {'text': text}


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    try:
        client = DevRevMCP()
        tools = client.discover()
        if len(sys.argv) == 1 or sys.argv[1] == 'discover':
            print(json.dumps(tools, ensure_ascii=False))
        elif sys.argv[1] == 'batch':
            calls = json.load(sys.stdin)
            if isinstance(calls, dict):
                calls = [calls]
            client.call('discover_schema', {})
            results = []
            for call in calls:
                try:
                    results.append(client.call(call['name'], call['arguments']))
                except Exception as error:
                    results.append({'read_error': type(error).__name__, 'tool': call['name']})
            print(json.dumps(results, ensure_ascii=False))
        else:
            raise ValueError('Unknown command')
    except Exception as error:
        # Never include credential-bearing requests or response bodies in errors.
        print('DevRev MCP failed: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
