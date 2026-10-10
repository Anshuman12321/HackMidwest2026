#!/usr/bin/env python3
"""Read-only remote checks for the retained import, not the full benchmark.

Writes a local inventory report. Never creates records or resumes the backlog.
"""
import collections
import concurrent.futures
import datetime
import json
from import_maple import HERE, PREFIX, Importer


def main():
    imp = Importer(HERE / 'data.zip')
    report = {
        'captured_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'scope': 'Manifest-retained Maple Payments import; remote reads only',
        'archive_sha256': imp.manifest['archive_sha256'],
        'families': {}, 'checks': {}, 'demo': [],
    }
    source = {}
    tasks = []
    for family, kind, path in (
        ('issues', 'issue', 'pm_json_data/issues.json'),
        ('tickets', 'ticket', 'crm_json_data/tickets.json'),
        ('opportunities', 'opportunity', 'crm_json_data/opportunities.json'),
    ):
        rows = imp.rows(path)
        source[family] = {r[kind + '_id']: r for r in rows}
        keys = list(imp.manifest[family])
        assert set(keys) <= set(source[family])
        field = 'stage' if family == 'opportunities' else 'status'
        report['families'][family] = {
            'source': len(rows), 'loaded': len(keys), 'not_loaded': len(rows) - len(keys),
            'source_states': dict(collections.Counter(r[field] for r in rows)),
            'loaded_states': dict(collections.Counter(source[family][k][field] for k in keys)),
        }
        for start in range(0, len(keys), 100):
            chunk = keys[start:start + 100]
            tasks.append((family, kind, chunk))

    def count_chunk(task):
        family, kind, keys = task
        obj = imp.api('works.count', {'type': [kind], 'external_ref': [PREFIX + k for k in keys]})
        assert obj['count'] == len(keys) and not obj.get('has_more'), (family, keys[0], obj)
        return family, obj['count']

    verified = collections.Counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for family, count in pool.map(count_chunk, tasks):
            verified[family] += count
    report['checks']['native_work_counts_by_exact_source_reference'] = dict(verified)

    for path, record in imp.manifest['articles'].items():
        obj = imp.api('articles.get', {'id': record['id']})['article']
        assert obj['status'] == 'published' and obj.get('extracted_content'), path
    report['checks']['published_articles_with_extracted_content'] = len(imp.manifest['articles'])

    for family, ids in [('issues', ['ISS-031', 'ISS-8448']), ('tickets', ['TKT-124', 'TKT-125', 'TKT-126'])]:
        for key in ids:
            native = imp.api('works.get', {'id': imp.manifest[family][key]['id']})['work']
            original = json.loads(native['body'].rsplit('```json\n', 1)[1].rsplit('\n```', 1)[0])
            assert original == source[family][key], key
            report['demo'].append({'source_id': key, 'native_id': native['display_id'],
                'title': native['title'], 'source_created_at': original.get('created_at'),
                'original_record_matches': True})

    for family, count in [('accounts', 42), ('contacts', 62), ('parts', 40), ('articles', 73), ('comments', 26)]:
        assert len(imp.manifest[family]) == count
        report['families'].setdefault(family, {'loaded': count, 'verification': 'manifest/journal; articles also read remotely'})
    crm = imp.rows('crm_json_data/users.json')
    pm = imp.rows('pm_json_data/users.json')
    known = {u['user_id'] for u in crm + pm}
    refs = {v for family in source.values() for r in family.values() for k, v in r.items()
            if k in ('owner_id', 'assignee_id', 'reporter_id', 'creator_id', 'created_by_id', 'modified_by_id') and v}
    report['people'] = {'crm_rows': len(crm), 'pm_rows': len(pm), 'unique_source_ids': len(known),
        'overlapping_ids': sorted({u['user_id'] for u in crm} & {u['user_id'] for u in pm}),
        'unresolved_work_people_ids_in_full_source': sorted(refs - known)}
    names = imp.archive.namelist()
    raw = [p for p in names if p.endswith(('.md', '.txt')) and p.startswith(('maple_kb/', 'internal_docs/', 'transcripts/'))]
    report['documents'] = {'raw_files': len(raw),
        'raw_by_directory': dict(collections.Counter(p.split('/')[0] for p in raw)),
        'metadata_articles': len(imp.manifest['articles']) - len(raw),
        'source_conversations': len(imp.rows('pm_json_data/conversations.json')),
        'source_comments': len(imp.rows('pm_json_data/comments.json'))}
    (HERE / 'inventory.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'verified_work_counts': dict(verified), 'published_articles': 73,
        'people': report['people'], 'documents': report['documents']}, indent=2))


if __name__ == '__main__':
    main()
