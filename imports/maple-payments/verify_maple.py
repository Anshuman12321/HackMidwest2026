#!/usr/bin/env python3
"""Verify native counts and representative source records after the import."""
import collections
import json
from import_maple import HERE, PREFIX, Importer

def main():
    imp = Importer(HERE / 'data.zip')
    report = {'dataset': imp.manifest['dataset'], 'archive_sha256': imp.manifest['archive_sha256'],
              'org_id': imp.manifest['org_id'], 'counts': {}, 'samples': [], 'limitations': [
                  'Native creation and modification dates reflect the import; source dates are preserved in content.',
                  'Native employee ownership is the importer; source ownership and directory records are preserved in content.',
                  'Opportunity prospecting maps to qualification and proposal maps to contract; original stages are preserved.',
                  'Source conversation containers are preserved as metadata; comments are native work timeline entries.',
                  'Only the first component is the native primary part; all source components remain in content.',
                  'Shared account domains remain in source metadata because DevRev requires unique native domains.']}
    for family, kind, path in [('issues', 'issue', 'pm_json_data/issues.json'),
                               ('tickets', 'ticket', 'crm_json_data/tickets.json'),
                               ('opportunities', 'opportunity', 'crm_json_data/opportunities.json')]:
        rows = imp.rows(path)
        assert len(imp.manifest[family]) == len(rows), (family, 'manifest incomplete')
        expected = collections.Counter(r['account_id'] if family == 'opportunities' else (r.get('components') or ['PART-001'])[0] for r in rows)
        total = 0
        for source_part, count in expected.items():
            filters = {'opportunity': {'account': [imp.manifest['accounts'][source_part]['id']]}} if family == 'opportunities' else {'applies_to_part': [imp.manifest['parts'][source_part]['id']]}
            result = imp.api('works.count', dict(type=[kind], **filters))
            if result.get('has_more') or result['count'] != count:
                # Avoid count caps and exclude any new team work added during the import.
                group = [r for r in rows if (r['account_id'] if family == 'opportunities' else (r.get('components') or ['PART-001'])[0]) == source_part]
                matched = 0
                for start in range(0, len(group), 100):
                    refs = [PREFIX + r[kind + '_id'] for r in group[start:start + 100]]
                    exact = imp.api('works.count', {'type': [kind], 'external_ref': refs})
                    assert not exact.get('has_more') and exact['count'] == len(refs), (family, source_part, exact, len(refs))
                    matched += exact['count']
                assert matched == count
                total += matched
            else:
                total += result['count']
        report['counts'][family] = {'source': len(rows), 'native_verified': total}
        sample_rows = rows[:2] + rows[-2:]
        sample_rows += [next(r for r in rows if r.get('status') == 'done')] if family == 'issues' else []
        sample_rows += [r for r in rows if r.get('ticket_id') in ('TKT-124', 'TKT-125', 'TKT-126')]
        for row in sample_rows:
            source_id = row[kind + '_id']
            native = imp.api('works.get', {'id': imp.manifest[family][source_id]['id']})['work']
            assert native['external_ref'] == PREFIX + source_id
            preserved = json.loads(native['body'].rsplit('```json\n', 1)[1].rsplit('\n```', 1)[0])
            assert preserved == row, (source_id, 'source content differs')
            report['samples'].append({'source_id': source_id, 'display_id': native['display_id'],
                'title': native['title'], 'stage': native.get('stage'), 'state': native.get('stage', {}).get('state', {}).get('name')})
    for family in ('accounts', 'contacts', 'parts', 'articles', 'comments'):
        report['counts'][family] = len(imp.manifest[family])
    for path, record in imp.manifest['articles'].items():
        article = imp.api('articles.get', {'id': record['id']})['article']
        assert article['status'] == 'published', path
        assert article.get('resource', {}).get('artifacts') and article.get('extracted_content'), path
    (HERE / 'verification.json').write_text(json.dumps(report, indent=2) + '\n')
    imp.manifest['status'] = 'complete_verified'
    imp.checkpoint()
    print(json.dumps(report['counts'], indent=2))

if __name__ == '__main__':
    main()
