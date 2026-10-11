"""Outcome-led, bounded DevRev MCP retrieval; never creates or updates work.

Run via contracts/run-investigation.ts. stdout is a private adapter message,
not the shared UI contract. Only the TypeScript validator emits that contract.
"""
import datetime
import hashlib
import json
import pathlib
import re
import sys
import zipfile
from devrev_mcp import DevRevMCP

ROOT = pathlib.Path(__file__).resolve().parents[1]
ORG = '1mWckJhGyy'
STOP = {'restore', 'investigate', 'resolve', 'fix', 'without', 'double', 'billing', 'the', 'and', 'for', 'with', 'of', 'in', 'to', 'a', 'an', 'payments'}


class RetrievalError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def terms(outcome):
    return list(dict.fromkeys(re.sub(r'(?:als|ions|ing|s)$', '', word) for word in re.findall(r'[a-z]{3,}', outcome.lower()) if word not in STOP))[:8]


def score(text, keywords):
    text = text.lower()
    return sum(term in text for term in keywords) / max(len(keywords), 1)


def object_value(result):
    context = result.get('object_context')
    if context:
        return json.loads(context)['object'] if isinstance(context, str) else context['object']
    return result.get('object', result)


def native(value):
    if not isinstance(value.get('id'), str) or ':devo/' + ORG + ':' not in value['id']:
        raise ValueError('Object is outside the reviewed Maple workspace')
    return {'id': value['id'], 'display_id': value['display_id'], 'url': None}


def retrieve(request, client):
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    manifest = json.loads((ROOT / 'imports/maple-payments/manifest.json').read_text())
    discovered = client.discover()
    tool_map = {tool['name']: tool for tool in discovered}
    trace = []
    hints = request['scope_hints']
    start = hints['starting_object']
    scope_ids = hints['part_ids'] + hints['account_ids'] + ([start['id']] if start else [])
    if any(not isinstance(value, str) or ':devo/' + ORG + ':' not in value for value in scope_ids):
        raise RetrievalError('permission_denied', 'Scope belongs to an unsupported workspace')
    if start and ':issue/' not in start['id']:
        raise RetrievalError('invalid_request', 'Starting object must be an issue')
    limitations = ['Bounded outcome searches are not an exhaustive workspace scan.',
                    'March source events are benchmark history; October imports and retrieval are not current runtime observations.',
                    'Historical source owners are retained as IDs but not resolved to current authorized assignees.',
                    'Current scheduler, queue, payment ledger, deployment logs and duplicate-charge tests are unavailable.']

    def call(name, arguments):
        tool = tool_map.get(name)
        if not tool or tool.get('annotations', {}).get('readOnlyHint') is not True:
            raise ValueError('Missing reviewed read-only MCP schema: ' + name)
        schema = tool['inputSchema']
        if not set(schema.get('required', [])).issubset(arguments):
            raise ValueError('Required MCP arguments missing')
        if set(arguments) - set(schema.get('properties', {})):
            raise ValueError('Undiscovered MCP argument')
        trace.append({'tool': name, 'arguments': arguments, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat()})
        return client.call(name, arguments)

    call('discover_schema', {})
    keywords = terms(request['outcome'])
    if not keywords:
        raise ValueError('Outcome has no resolvable subject')
    records = []
    entities = []
    candidates = {}
    for kind in ('issue', 'ticket'):
        result = call('hybrid_search', {'query': f"Which Maple Payments {kind}s are relevant to this outcome: {request['outcome']}?"[:400],
                                       'namespace': kind, 'limit': 10, 'projection_type': 'id_with_label'})
        matches = result.get('results', [])
        # Hints are native IDs, never a baked-in demo evidence list.
        ids = [item['id'] for item in matches if ':devo/' + ORG + ':' + kind + '/' in item['id']]
        if start and ':' + kind + '/' in start['id']:
            ids = [start['id']] + [value for value in ids if value != start['id']]
        ids = ids[:12]
        if not ids:
            continue
        result = call('execute_dql', {'dql_query': {'filter': {'field': kind + '.id', 'op': 'in', 'value': ids[:12], 'value_type': 'json'}, 'limit': 12},
                                     'fields': ['id', 'display_id', 'title', 'body', 'external_ref', 'applies_to_part']})
        if result.get('next_cursor'):
            limitations.append('Candidate reads were capped; additional DQL pages were not retrieved.')
        for value in result.get(kind + 's', []):
            is_start = bool(start and value['id'] == start['id'])
            if value.get('id') not in ids:
                raise ValueError('MCP returned an unrequested object')
            fenced = re.findall(r'```json\s*\n(.*?)\n```', value.get('body', ''), re.S)
            rows = []
            for block in fenced:
                try:
                    row = json.loads(block)
                    if isinstance(row, dict) and kind + '_id' in row:
                        rows.append(row)
                except json.JSONDecodeError:
                    pass
            if len(rows) != 1:
                if is_start:
                    raise RetrievalError('evidence_changed', 'Starting issue has no complete original JSON')
                limitations.append(f"{value['display_id']}: complete original JSON was unavailable or ambiguous; not cited.")
                continue
            row = rows[0]
            source_id = row[kind + '_id']
            mapping = manifest[kind + 's'].get(source_id)
            if not mapping or native(value) != {**mapping, 'url': None} or value.get('external_ref') != 'enterprise-bench/maple/' + source_id:
                raise ValueError('Source/native identity mismatch')
            rank = score(str(row.get('title', row.get('subject', ''))) + ' ' + str(row.get('description', '')), keywords)
            if rank < 0.8 and not is_start:
                continue
            part = value.get('applies_to_part', {})
            part_source = next((key for key, obj in manifest['parts'].items() if obj['id'] == part.get('id')), None)
            if not part_source or part_source not in row.get('components', []):
                raise ValueError('Source/native product-part mismatch')
            hints = request['scope_hints']
            if hints['part_ids'] and part['id'] not in hints['part_ids']:
                if is_start:
                    raise RetrievalError('invalid_request', 'Starting issue is excluded by product-part scope')
                continue
            account_source = row.get('account_id')
            if hints['account_ids'] and manifest['accounts'].get(account_source, {}).get('id') not in hints['account_ids']:
                if is_start:
                    raise RetrievalError('invalid_request', 'Starting issue is excluded by account scope')
                continue
            reference = request['reference_time']
            if reference:
                cutoff = datetime.datetime.fromisoformat(reference.replace('Z', '+00:00'))
                dates = [row.get('created_at'), row.get('updated_at')]
                if not row.get('created_at') or any(datetime.datetime.fromisoformat(date.replace('Z', '+00:00')) > cutoff for date in dates if date):
                    if is_start:
                        raise RetrievalError('invalid_request', 'Starting issue is excluded by the as-of time')
                    limitations.append(f"{source_id}: excluded because the available row is undated or newer than the as-of time.")
                    continue
            candidates[source_id] = {'kind': kind, 'source_id': source_id, 'path': 'pm_json_data/issues.json' if kind == 'issue' else 'crm_json_data/tickets.json',
                                     'label': value['title'], 'native': native(value), 'original': row, 'coverage': 'native_imported',
                                     'retrieved_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'part_source_id': part_source,
                                     'account_source_id': account_source, 'rank': rank, 'is_start': is_start}
    if start and not any(row['native']['id'] == start['id'] for row in candidates.values()):
        raise RetrievalError('permission_denied', 'Starting issue is inaccessible or could not be retrieved')
    issues = sorted((r for r in candidates.values() if r['kind'] == 'issue'), key=lambda r: (not r['is_start'], -r['rank'], r['source_id']))[:2]
    tickets = sorted((r for r in candidates.values() if r['kind'] == 'ticket'), key=lambda r: (-r['rank'], r['source_id']))[:6]
    records.extend(issues + tickets)
    related = [('parts', 'part', key) for key in dict.fromkeys(r['part_source_id'] for r in records)]
    related += [('accounts', 'account', key) for key in dict.fromkeys(r['account_source_id'] for r in records if r['account_source_id'])]
    for family, kind, key in related:
        mapping = manifest[family][key]
        try:
            obj = object_value(call('fetch_object_context', {'object_id': mapping['id']}))
            if native(obj) != {k: mapping[k] for k in ('id', 'display_id')} | {'url': None}:
                raise ValueError('Related native ID mismatch')
            if kind == 'part' and key not in obj.get('description', ''):
                raise ValueError('Part source ID not found in native metadata')
            if kind == 'account' and 'enterprise-bench/maple/' + key not in obj.get('external_refs', []):
                raise ValueError('Account source ID not found in native metadata')
            entities.append({'kind': kind, 'source_id': key, 'path': 'pm_json_data/maple_parts.json' if kind == 'part' else 'crm_json_data/accounts.json',
                             'label': obj.get('name', obj.get('display_name', key)), 'native': native(obj)})
        except Exception:
            limitations.append(f'{key}: native related-object/source identity could not be verified; omitted.')

    # Documents are scoped by the product topic, not by a fixed ART-* evidence list.
    topic = 'subscription' if any('subscript' in term or 'renew' in term for term in keywords) else ' '.join(keywords)
    doc_hits = call('hybrid_search', {'query': f'Which Maple Payments documents explain {topic} behavior, recovery and safety?',
                                    'namespace': 'article', 'limit': 6, 'projection_type': 'id_with_label'}).get('results', [])
    doc_result = call('execute_dql', {'dql_query': {'expression': {'query': topic}, 'filter': {'field': 'article.object_type', 'op': 'in', 'value': ['article'], 'value_type': 'json'}, 'limit': 10},
                                      'fields': ['id', 'display_id', 'title', 'description', 'resource', 'extracted_content']})
    docs = doc_result.get('articles', [])
    if doc_hits and not docs:
        docs = call('execute_dql', {'dql_query': {'filter': {'field': 'article.id', 'op': 'in', 'value': [item['id'] for item in doc_hits], 'value_type': 'json'}, 'limit': 10},
                                     'fields': ['id', 'display_id', 'title', 'description', 'resource', 'extracted_content']}).get('articles', [])
    # Article bytes cannot be asserted from an index snippet; use bounded archive
    # fallback only after native access has been attempted. Never upgrade coverage.
    doc_keys = [key for key in manifest['articles'] if topic in key.lower() or (topic == 'subscription' and re.search(r'retry|dunning', key.lower()))]
    doc_keys.sort(key=lambda key: (-sum(word in key for word in ('recurring', 'retry', 'dunning', 'churn')), key))
    if not docs:
        limitations.append('Native article search returned no readable articles. Documentation below is explicitly archive-only; native permissions/indexing are unverified.')
    else:
        limitations.append('Native article metadata is readable but exact article bytes are not normalized by this adapter; documentation is archive-only.')
    archive_path = ROOT / 'imports/maple-payments/data.zip'
    if doc_keys:
        if hashlib.sha256(archive_path.read_bytes()).hexdigest() != manifest['archive_sha256']:
            raise ValueError('Archive checksum mismatch')
        with zipfile.ZipFile(archive_path) as archive:
            for path in doc_keys[:4]:
                content = archive.read(path).decode('utf-8')
                # Undated Markdown cannot establish an as-of historical policy.
                if request['reference_time']:
                    limitations.append(f'{path}: undated documentation excluded from an as-of investigation.')
                    continue
                records.append({'kind': 'article', 'source_id': path, 'path': path,
                                'label': next((line.lstrip('# ').strip() for line in content.splitlines() if line.startswith('# ')), pathlib.Path(path).stem),
                                'native': None, 'original': content, 'coverage': 'archive_only', 'retrieved_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                                'part_source_id': None, 'account_source_id': None})
    return {'records': records, 'entities': entities, 'archive_sha256': manifest['archive_sha256'],
            'limitations': list(dict.fromkeys(limitations))[:20], 'discovered_tools': discovered, 'trace': trace, 'started_at': now}


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    try:
        print(json.dumps(retrieve(json.load(sys.stdin), DevRevMCP(local=True)), ensure_ascii=False))
    except Exception as error:
        print('Read-only investigation retrieval failed: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
