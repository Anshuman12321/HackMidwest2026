"""One stdin JSON request -> one sanitized stdout JSON response.

Only local=true opts into personal MCP configuration. Production requests must
carry the trusted HTTP agent's explicit actor bearer in context. No credentials
are accepted as command arguments, returned, persisted, or printed.
"""
import datetime
import hashlib
import json
import re
import sys
import urllib.error
import zipfile
from devrev_mcp import DevRevMCP
from retrieve_investigation import ROOT, ORG, RetrievalError, native, object_value, retrieve


def timestamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def source_hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def identity(client):
    user = client.native_read('dev-users.self', {}).get('dev_user', {})
    if user.get('state') != 'active' or not isinstance(user.get('id'), str) or ':devo/' + ORG + ':devu/' not in user['id']:
        raise RetrievalError('permission_denied', 'An active actor in the supported workspace is required')
    return {'actor_id': user['id'], 'workspace': ORG}


def exact_revalidate(response, client):
    """Reread reviewed IDs, never rerun outcome search or historical filtering.

    Returned retrieval timestamps are deliberately fresh. The TypeScript layer
    checks citations against these bytes while retaining the recorded provenance
    timestamps from the approved response for comparison.
    """
    started_at = timestamp()
    bundle = response['context_bundle']
    manifest = json.loads((ROOT / 'imports/maple-payments/manifest.json').read_text())
    discovered = client.discover()
    tool_map = {tool['name']: tool for tool in discovered}
    trace = []

    def call(name, arguments):
        tool = tool_map.get(name)
        if not tool or tool.get('annotations', {}).get('readOnlyHint') is not True:
            raise RetrievalError('blocked', 'Required read-only MCP schema is unavailable')
        schema = tool['inputSchema']
        if not set(schema.get('required', [])).issubset(arguments) or set(arguments) - set(schema.get('properties', {})):
            raise RetrievalError('blocked', 'Read arguments do not match the discovered schema')
        trace.append({'tool': name, 'arguments': arguments, 'at': timestamp()})
        return client.call(name, arguments)

    call('discover_schema', {})
    entities = {entity['entity_id']: entity for entity in bundle['entities']}
    cited = {}
    for evidence in bundle['evidence']:
        entity = entities.get(evidence['entity_id'])
        if not entity or entity['source_ref'] != {key: evidence['source_ref'][key] for key in ('record_id', 'path')}:
            raise RetrievalError('evidence_changed', 'Citation source identity does not match its entity')
        key = evidence['source_ref']['record_id']
        if key in cited and cited[key]['entity_id'] != entity['entity_id']:
            raise RetrievalError('evidence_changed', 'Duplicate source identity')
        cited[key] = entity
    if len(cited) > 12 or len(bundle['entities']) > 28:
        raise RetrievalError('invalid_request', 'Review exceeds the bounded retrieval size')
    records = []
    for kind in ('issue', 'ticket'):
        requested = [entity for entity in cited.values() if entity['kind'] == kind]
        ids = []
        for entity in requested:
            mapping = manifest[kind + 's'].get(entity['source_ref']['record_id'])
            if not mapping or entity['native'] != {**mapping, 'url': None}:
                raise RetrievalError('evidence_changed', 'Native work mapping changed')
            ids.append(mapping['id'])
        if not ids:
            continue
        result = call('execute_dql', {'dql_query': {'filter': {'field': kind + '.id', 'op': 'in', 'value': ids, 'value_type': 'json'}, 'limit': 12},
                                      'fields': ['id', 'display_id', 'title', 'body', 'external_ref', 'applies_to_part']})
        rows = result.get(kind + 's', [])
        if len(rows) != len(ids) or {value.get('id') for value in rows} != set(ids):
            raise RetrievalError('permission_denied', 'A cited work is no longer accessible')
        for value in rows:
            row_values = []
            for block in re.findall(r'```json\s*\n(.*?)\n```', value.get('body', ''), re.S):
                try:
                    original = json.loads(block)
                    if isinstance(original, dict) and kind + '_id' in original:
                        row_values.append(original)
                except json.JSONDecodeError:
                    pass
            if len(row_values) != 1:
                raise RetrievalError('evidence_changed', 'A cited original record is unavailable or ambiguous')
            original = row_values[0]
            key = original[kind + '_id']
            entity = cited.get(key)
            if not entity or entity['kind'] != kind or native(value) != entity['native'] or value.get('external_ref') != 'enterprise-bench/maple/' + key:
                raise RetrievalError('evidence_changed', 'Cited source/native identity changed')
            part_key = next((source for source, mapping in manifest['parts'].items() if mapping['id'] == value.get('applies_to_part', {}).get('id')), None)
            if not part_key or part_key not in original.get('components', []):
                raise RetrievalError('evidence_changed', 'Cited source/native product-part join changed')
            account_key = original.get('account_id')
            if account_key is not None and account_key not in manifest['accounts']:
                raise RetrievalError('evidence_changed', 'Cited account source identity changed')
            records.append({'kind': kind, 'source_id': key, 'path': 'pm_json_data/issues.json' if kind == 'issue' else 'crm_json_data/tickets.json',
                            'label': value['title'], 'native': native(value), 'original': original, 'coverage': 'native_imported',
                            'retrieved_at': timestamp(), 'part_source_id': part_key, 'account_source_id': account_key})

    related = []
    for entity in bundle['entities']:
        kind = entity['kind']
        if kind not in ('part', 'account'):
            if entity['source_ref']['record_id'] not in cited:
                raise RetrievalError('evidence_changed', 'A reviewed source has no citation')
            continue
        key = entity['source_ref']['record_id']
        mapping = manifest[kind + 's'].get(key)
        if not mapping or entity['native'] != {key: mapping[key] for key in ('id', 'display_id')} | {'url': None}:
            raise RetrievalError('evidence_changed', 'Related native mapping changed')
        # Permission failures propagate; missing related reads cannot become an
        # apparently successful evidence refresh with fewer source joins.
        obj = object_value(call('fetch_object_context', {'object_id': mapping['id']}))
        if not obj.get('id'):
            raise RetrievalError('permission_denied', 'A related source is no longer accessible')
        if native(obj) != entity['native']:
            raise RetrievalError('evidence_changed', 'Related native identity changed')
        if (kind == 'part' and key not in obj.get('description', '')) or (kind == 'account' and 'enterprise-bench/maple/' + key not in obj.get('external_refs', [])):
            raise RetrievalError('evidence_changed', 'Related source/native join changed')
        related.append({'kind': kind, 'source_id': key, 'path': 'pm_json_data/maple_parts.json' if kind == 'part' else 'crm_json_data/accounts.json',
                        'label': obj.get('name', obj.get('display_name', key)), 'native': native(obj)})

    archive_path = ROOT / 'imports/maple-payments/data.zip'
    archive_hash = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    if archive_hash != manifest['archive_sha256'] or archive_hash != bundle['coverage']['archive_sha256']:
        raise RetrievalError('evidence_changed', 'Archive checksum changed')
    with zipfile.ZipFile(archive_path) as archive:
        for key, entity in cited.items():
            if entity['kind'] != 'article':
                continue
            if key not in manifest['articles'] or entity['source_ref']['path'] != key or entity['native'] is not None:
                raise RetrievalError('evidence_changed', 'Archive document identity changed')
            content = archive.read(key).decode('utf-8')
            records.append({'kind': 'article', 'source_id': key, 'path': key, 'label': entity['label'], 'native': None, 'original': content,
                            'coverage': 'archive_only', 'retrieved_at': timestamp(), 'part_source_id': None, 'account_source_id': None})
    by_source = {record['source_id']: record for record in records}
    for evidence in bundle['evidence']:
        source = by_source.get(evidence['source_ref']['record_id'])
        if not source or source['path'] != evidence['source_ref']['path'] or source_hash(source['original']) != evidence['source_ref']['content_sha256'] or source['coverage'] != evidence['coverage']:
            raise RetrievalError('evidence_changed', 'Reviewed evidence bytes, source path or coverage changed')
    return {'records': records, 'entities': related, 'archive_sha256': archive_hash,
            'limitations': bundle['coverage']['limitations'], 'discovered_tools': discovered, 'trace': trace, 'started_at': started_at}


def dispatch(message, factory=DevRevMCP):
    operation = message.get('operation')
    if operation not in ('investigate', 'revalidate', 'identity', 'native'):
        raise RetrievalError('invalid_request', 'Unsupported bridge operation')
    local = message.get('local', False)
    if not isinstance(local, bool):
        raise RetrievalError('invalid_request', 'Local mode must be an explicit boolean')
    context = message.get('context')
    if not local:
        if not isinstance(context, dict) or context.get('workspace') != ORG or ':devo/' + ORG + ':devu/' not in str(context.get('actor_id', '')):
            raise RetrievalError('permission_denied', 'Trusted actor context for the supported workspace is required')
        if not isinstance(context.get('actor_session_token'), str) or not context['actor_session_token']:
            raise RetrievalError('permission_denied', 'Explicit actor bearer is required')
    client = factory(local=local, actor_session_token=None if local else context['actor_session_token'], initialize=False)
    verified = identity(client)
    if context and (context.get('workspace') != verified['workspace'] or context.get('actor_id') != verified['actor_id']):
        raise RetrievalError('permission_denied', 'Actor identity does not match the trusted context')
    if operation == 'identity':
        return verified
    payload = message.get('payload', {})
    if operation == 'native':
        endpoint, args = payload.get('endpoint'), payload.get('args', {})
        if endpoint != 'dev-users.self' and (not isinstance(args.get('id'), str) or ':devo/' + ORG + ':' not in args['id']):
            raise RetrievalError('permission_denied', 'Native source belongs to an unsupported workspace')
        return client.native_read(endpoint, args)
    client.initialize()
    if operation == 'investigate':
        return retrieve(payload, client)
    return exact_revalidate(payload, client)


def main():
    try:
        message = json.load(sys.stdin)
        result = dispatch(message)
        print(json.dumps({'ok': True, 'result': result}, ensure_ascii=False))
    except urllib.error.HTTPError as error:
        code = 'permission_denied' if error.code in (401, 403, 404) else 'blocked'
        print(json.dumps({'ok': False, 'error': {'code': code, 'message': 'The actor-scoped DevRev read was denied or unavailable'}}))
    except Exception as error:
        code = error.code if isinstance(error, RetrievalError) else 'blocked'
        # Exception bodies, request data and credentials never reach stdout/stderr.
        message = str(error) if isinstance(error, RetrievalError) else 'The read-only investigation could not be verified'
        print(json.dumps({'ok': False, 'error': {'code': code, 'message': message}}))


if __name__ == '__main__':
    main()
