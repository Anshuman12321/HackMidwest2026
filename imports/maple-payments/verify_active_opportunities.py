#!/usr/bin/env python3
"""Check every active source opportunity against its native DevRev record."""
import collections
import datetime
import decimal
import json
from import_maple import HERE, PREFIX, Importer

def main():
    imp = Importer(HERE / 'data.zip')
    rows = [r for r in imp.rows('crm_json_data/opportunities.json') if r['stage'] not in ('closed_won', 'closed_lost')]
    count = imp.api('works.count', {'type': ['opportunity'], 'external_ref': [PREFIX + r['opportunity_id'] for r in rows]})
    assert count['count'] == len(rows) and not count.get('has_more'), count
    verified = []
    for row in rows:
        key = row['opportunity_id']
        obj = imp.api('works.get', {'id': imp.manifest['opportunities'][key]['id']})['work']
        assert obj['external_ref'] == PREFIX + key, key
        assert obj['account']['id'] == imp.manifest['accounts'][row['account_id']]['id'], key
        assert decimal.Decimal(obj['value']['amount']) == decimal.Decimal(str(row['acv'])), key
        assert obj['value']['currency'] == row['currency'], key
        stage = {'prospecting': 'qualification', 'proposal': 'contract'}.get(row['stage'], row['stage'])
        assert obj['stage']['name'] == stage, key
        original = json.loads(obj['body'].rsplit('```json\n', 1)[1].rsplit('\n```', 1)[0])
        assert original == row, key
        source_date = row['target_close_date'] if 'T' in row['target_close_date'] else row['target_close_date'] + 'T00:00:00Z'
        assert datetime.datetime.fromisoformat(obj['target_close_date'].replace('Z', '+00:00')) == datetime.datetime.fromisoformat(source_date.replace('Z', '+00:00')), key
        verified.append({'source_id': key, 'display_id': obj['display_id'], 'title': obj['title'],
            'account': obj['account']['display_name'], 'value': obj['value'],
            'source_stage': row['stage'], 'native_stage': stage})
    report = {'scope': 'Active Enterprise-Bench Maple Payments opportunities', 'native_count': count['count'],
        'verified': verified, 'source_stages': dict(collections.Counter(r['stage'] for r in rows)),
        'native_stages': dict(collections.Counter(r['native_stage'] for r in verified))}
    (HERE / 'opportunities-verification.json').write_text(json.dumps(report, indent=2) + '\n')
    imp.manifest['opportunities_status'] = 'active_30_verified'
    imp.checkpoint()
    print(json.dumps({'verified_count': len(rows), 'source_stages': report['source_stages'], 'examples': verified[:3]}, indent=2))

if __name__ == '__main__':
    main()
