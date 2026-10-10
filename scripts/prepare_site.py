#!/usr/bin/env python3
"""Build the public presentation snapshot from permitted source data and reports."""
import hashlib
import json
import pathlib
import shutil
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE = ROOT / 'imports/maple-payments'
DIST = ROOT / 'sites/ripple-demo/dist'
manifest = json.loads((BASE / 'manifest.json').read_text())
archive = zipfile.ZipFile(BASE / 'data.zip')
assert hashlib.sha256((BASE / 'data.zip').read_bytes()).hexdigest() == manifest['archive_sha256']
inventory = json.loads((BASE / 'inventory.json').read_text())
evidence = []
for family, path, field, keys in (
    ('issues', 'pm_json_data/issues.json', 'issue_id', ['ISS-031']),
    ('tickets', 'crm_json_data/tickets.json', 'ticket_id', ['TKT-124', 'TKT-125', 'TKT-126']),
):
    for row in json.loads(archive.read(path)):
        if row[field] not in keys:
            continue
        evidence.append({'sourceId': row[field], 'nativeId': manifest[family][row[field]]['display_id'],
            'title': row.get('title') or row['subject'], 'date': row['created_at'],
            'body': row['description'], 'path': path, 'locator': 'description',
            'accountId': row.get('account_id'), 'partId': 'PART-003',
            'contentVersion': hashlib.sha256(json.dumps(row, sort_keys=True).encode()).hexdigest()})
for needle, short in [('retry-logic','retry'),('subscriptions-recurring','billing')]:
    path = next(p for p in manifest['articles'] if p.startswith('maple_kb/') and needle in p)
    content = archive.read(path).decode()
    evidence.append({'sourceId': short, 'nativeId': manifest['articles'][path]['display_id'],
        'title': next((line.lstrip('# ') for line in content.splitlines() if line.startswith('# ')), pathlib.Path(path).stem), 'body': content[:2200],
        'path': path, 'locator': 'first 2,200 characters; excerpt may be truncated',
        'contentVersion': hashlib.sha256(content.encode()).hexdigest()})
rows = [
    ('Issues', 'issues', 'full', 'All source issues are native. Source done/in_progress maps to native completed/in_development. Original dates and people stay in the body.', 'Maple ISS-031 or ISS-42'),
    ('Tickets', 'tickets', 'partial', 'All 51 open reports and 11,371 solved reports are loaded. The user stopped the remaining 21,346 closed records. Include resolved stages to see history.', 'Maple TKT-124 or TKT-50'),
    ('Active opportunities', 'opportunities', 'partial', 'All 30 active deals are loaded. The 8,674 closed deals remain in the source ZIP. Every active account, value, currency, stage, and target date was checked.', 'Maple OPP-001'),
    ('Accounts', 'accounts', 'full', 'All 42 accounts and their customer organizations are mapped. Full source commercial metadata is in content. Two source accounts share a domain; native domains must be unique.', '[Maple] TechFlow Payments Inc'),
    ('Customer contacts', 'contacts', 'full', 'All 62 source customer contacts are native and linked to accounts. This does not create employee workspace access.', 'Open a Maple account and inspect its contacts'),
    ('Product parts', 'parts', 'full', 'One product, six capabilities, and 33 features. The first source component is the native primary part. Other components stay in original content.', 'Maple Payments Platform or CAPL-4'),
    ('Raw documents', None, 'full', '55 KB files, eight internal documents, and three transcripts are published as internal articles. The KB JSON index is not the complete Markdown file list.', '[Maple] Failed Payment Retry Logic'),
    ('Metadata articles', None, 'metadata', 'Seven source files preserve directories, conversations, comments, KB and transcript indexes, and compliance data. JSON content is available as evidence.', 'Maple users or Maple conversations'),
    ('Timeline comments', 'comments', 'metadata', '26 source comments attach to native work timelines. Original authors, dates, and source visibility remain in provenance. Imported comments are internal.', 'Inspect the mapped work timeline'),
    ('Source people', None, 'metadata', '294 distinct people in the CRM and PM directories. All people IDs used by the source work records resolve. Only 62 customer contacts are native identities; employees were not invited.', 'Open the Maple people directory articles'),
    ('Conversation containers', None, 'metadata', '23 discussions are preserved in metadata. They are not 23 native inbound support conversations.', 'Maple conversations metadata article'),
]
data = []
for title, family, coverage, note, lookup in rows:
    if family:
        record = inventory['families'][family]
        loaded, source = record['loaded'], record.get('source', record['loaded'])
    else:
        loaded, source = {'Raw documents': (66,66), 'Metadata articles': (7,7),
                          'Source people': (294,294), 'Conversation containers': (23,23)}[title]
    data.append({'title': title, 'loaded': loaded, 'source': source, 'coverage': coverage, 'note': note, 'lookup': lookup})
(DIST / 'snapshot.json').write_text(json.dumps({'capturedAt': inventory['captured_at'],
    'archiveSha256': manifest['archive_sha256'], 'evidence': evidence, 'inventory': data}, indent=2) + '\n')
(DIST / 'docs').mkdir(exist_ok=True)
for name in ('data-and-integrations.md', 'agent-build-guide.md'):
    shutil.copyfile(ROOT / 'docs' / name, DIST / 'docs' / name)
print('Snapshot prepared: 6 evidence excerpts, 11 inventory entries, 2 handoff documents.')
