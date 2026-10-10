#!/usr/bin/env python3
"""Resumable Enterprise-Bench import. Credentials are read locally, never logged."""
import argparse
import concurrent.futures
import hashlib
import http.client
import json
import pathlib
import ssl
import threading
import time
import uuid
import zipfile
import urllib.request
from urllib.parse import urlsplit

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
PREFIX = 'enterprise-bench/maple/'

class Importer:
    def __init__(self, archive):
        self.manifest = json.loads((HERE / 'manifest.json').read_text())
        self.archive = zipfile.ZipFile(archive)
        assert hashlib.sha256(pathlib.Path(archive).read_bytes()).hexdigest() == self.manifest['archive_sha256']
        self.token = ''
        for line in (ROOT / '.env').read_text().splitlines():
            key, sep, value = line.removeprefix('export ').partition('=')
            if sep and key.strip() == 'DEVREV_PAT':
                self.token = value.strip().strip('\"\'')
        if not self.token:
            raise RuntimeError('DEVREV_PAT is empty')
        self.local = threading.local()
        self.lock = threading.RLock()
        self.pause_until = 0
        self.stop = threading.Event()
        self.journal = HERE / 'journal.jsonl'
        if self.journal.exists():
            for line in self.journal.read_text().splitlines():
                event = json.loads(line)
                self.manifest.setdefault(event['family'], {})[event['key']] = event['value']
        user = self.api('dev-users.self', {})['dev_user']
        assert user['id'] == self.manifest['owner'], 'PAT belongs to a different user/org'
        self.owner = user['id']
        self.product = self.manifest['parts']['PART-001']['id']
        self.checkpoint()

    def api(self, endpoint, payload):
        waited = False
        while True:
            if self.stop.is_set():
                raise RuntimeError('Import stopped after an error')
            wait = self.pause_until - time.time()
            if wait > 0:
                waited = True
                time.sleep(min(wait, 1))
                continue
            break
        conn = getattr(self.local, 'conn', None)
        if waited and conn is not None:
            conn.close()
            conn = None
        if conn is None:
            conn = http.client.HTTPSConnection('api.devrev.ai', timeout=90, context=ssl.create_default_context())
            self.local.conn = conn
        try:
            conn.request('POST', '/' + endpoint, json.dumps(payload).encode(),
                         {'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'})
            response = conn.getresponse()
            raw = response.read()
        except Exception:
            self.local.conn = None
            # A create might already have committed. Stop rather than create a duplicate.
            self.stop.set()
            raise RuntimeError('Ambiguous network failure at ' + endpoint + '; reconcile before resuming') from None
        if response.status == 429:
            delay = float(response.getheader('Retry-After') or 30)
            with self.lock:
                self.pause_until = max(self.pause_until, time.time() + delay + 1)
            if not getattr(self.local, 'rate_message_printed', False):
                print(json.dumps({'rate_limited_seconds': delay}), flush=True)
                self.local.rate_message_printed = True
            return self.api(endpoint, payload)
        if response.status >= 400:
            self.stop.set()
            # Do not log headers, request credentials, or signed artifact URLs.
            raise RuntimeError(endpoint + ' HTTP ' + str(response.status) + ': ' + raw.decode()[:1800])
        return json.loads(raw)

    def rows(self, name):
        return json.loads(self.archive.read(name))

    def checkpoint(self):
        with self.lock:
            tmp = HERE / 'manifest.tmp'
            tmp.write_text(json.dumps(self.manifest, indent=2) + '\n')
            tmp.replace(HERE / 'manifest.json')

    def save(self, family, key, obj, **extra):
        value = {k: obj[k] for k in ('id', 'display_id') if k in obj}
        value.update(extra)
        with self.lock:
            self.manifest.setdefault(family, {})[key] = value
            with self.journal.open('a') as stream:
                stream.write(json.dumps({'family': family, 'key': key, 'value': value}) + '\n')
                stream.flush()
            if len(self.manifest[family]) % 250 == 0:
                self.checkpoint()
        return value

    def body(self, row, source, text=''):
        return text + '\n\n---\nSynthetic Enterprise-Bench source: ' + source + '.\n' + \
            'Original record (source dates and people are historical; native owner is the importer):\n```json\n' + \
            json.dumps(row, indent=2, ensure_ascii=False) + '\n```'

    def account(self, row):
        accounts = self.rows('crm_json_data/accounts.json')
        unique_domain = sum(a.get('domain') == row.get('domain') for a in accounts) == 1
        obj = self.api('accounts.create', {'display_name': '[Maple] ' + row['account_name'],
            'description': self.body(row, 'crm_json_data/accounts.json'),
            'domains': [row['domain']] if row.get('domain') and unique_domain else [], 'websites': [row['website']] if row.get('website') else [],
            'external_refs': [PREFIX + row['account_id']], 'owned_by': [self.owner]})
        return self.save('accounts', row['account_id'], obj['account'], rev_org=obj['default_rev_org']['id'])

    def contact(self, row):
        acc = self.manifest['accounts'][row['account_id']]
        obj = self.api('rev-users.create', {'display_name': row['first_name'] + ' ' + row['last_name'],
            'email': row['email'], 'external_ref': PREFIX + row['user_id'],
            'account': acc['id'], 'rev_org': acc['rev_org'],
            'description': self.body(row, 'crm_json_data/users.json')})['rev_user']
        return self.save('contacts', row['user_id'], obj)

    def work(self, family, row):
        kind = {'issues': 'issue', 'tickets': 'ticket', 'opportunities': 'opportunity'}[family]
        key = row[kind + '_id']
        component = (row.get('components') or ['PART-001'])[0]
        title = row.get('title') or row.get('subject') or row.get('opportunity_name')
        source = ('pm' if family == 'issues' else 'crm') + '_json_data/' + family + '.json'
        payload = {'type': kind, 'title': ('[Maple ' + key + '] ' + title)[:256],
            'body': self.body(row, source, row.get('description', '')),
            'owned_by': [self.owner], 'applies_to_part': self.manifest['parts'][component]['id'],
            'external_ref': PREFIX + key, 'stage_validation_options': ['allow_non_start']}
        if family == 'issues':
            payload['stage'] = {'name': 'completed' if row['status'] == 'done' else 'in_development'}
            payload['priority'] = {'highest': 'p0', 'high': 'p1', 'medium': 'p2', 'low': 'p3'}[row['priority']]
        elif family == 'tickets':
            acc = self.manifest['accounts'][row['account_id']]
            payload.update(account=acc['id'], rev_org=acc['rev_org'], visibility=1,
                severity={'p0': 'blocker', 'p1': 'high', 'p2': 'medium', 'p3': 'low'}[row['priority']],
                source_channel=row.get('channel', 'import'), stage={'name': 'resolved' if row['status'] == 'solved' else 'open'})
            reporter = self.manifest.get('contacts', {}).get(row.get('reporter_id'))
            if reporter:
                payload['reported_by'] = [reporter['id']]
        else:
            payload.update(account=self.manifest['accounts'][row['account_id']]['id'], value={'amount': str(row['acv']), 'currency': row['currency']},
                target_close_date=row['target_close_date'] if 'T' in row['target_close_date'] else row['target_close_date'] + 'T00:00:00Z',
                forecast_category='won' if row['stage'] == 'closed_won' else 'omitted' if row['stage'] == 'closed_lost' else 'pipeline',
                stage={'name': {'prospecting': 'qualification', 'proposal': 'contract'}.get(row['stage'], row['stage'])})
        if len(payload['body'].encode()) > 65536:
            raise RuntimeError('Work exceeds body limit: ' + key)
        obj = self.api('works.create', payload)['work']
        return self.save(family, key, obj)

    def artifact(self, name, content, mime):
        prepared = self.api('artifacts.prepare', {'file_name': name, 'file_type': mime, 'configuration_set': 'default'})
        boundary = 'MapleImport' + uuid.uuid4().hex
        chunks = []
        for field in prepared['form_data']:
            chunks.append(('--' + boundary + '\r\nContent-Disposition: form-data; name="' + field['key'] + '"\r\n\r\n' + field['value'] + '\r\n').encode())
        chunks.append(('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="upload"\r\nContent-Type: ' + mime + '\r\n\r\n').encode())
        chunks.extend([content, ('\r\n--' + boundary + '--\r\n').encode()])
        req = urllib.request.Request(prepared['url'], b''.join(chunks), {'Content-Type': 'multipart/form-data; boundary=' + boundary}, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=90) as response:
                response.read()
        except Exception:
            raise RuntimeError('Artifact upload failed for ' + name + '; upload credentials omitted') from None
        return prepared['id']

    def article(self, row):
        name = row['path']
        text = self.archive.read(name).decode()
        title = next((l.strip('# ').strip() for l in text.splitlines() if l.startswith('# ')), pathlib.Path(name).stem.replace('_', ' '))
        title = ('[Maple] ' + title)[:256]
        text = 'Synthetic Enterprise-Bench evidence. Source: ' + name + '. Source dates are historical.\n\n' + text
        rt = self.artifact(pathlib.Path(name).name, json.dumps({'article': text}).encode(), 'devrev/rt')
        extracted = self.artifact(pathlib.Path(name).name + '.txt', text.encode(), 'text/plain')
        obj = self.api('articles.create', {'title': title, 'description': 'Enterprise-Bench source: ' + name,
            'owned_by': [self.owner], 'applies_to_parts': [self.product], 'scope': 1,
            'resource': {'artifacts': [rt]}, 'extracted_content': [extracted]})['article']
        result = self.save('articles', name, obj)
        self.api('articles.update', {'id': obj['id'], 'status': 'published'})
        return result

    def comment(self, row):
        conv = next(c for c in self.rows('pm_json_data/conversations.json') if c['conversation_id'] == row['conversation_id'])
        family = {'issue': 'issues', 'ticket': 'tickets'}[conv['parent_type']]
        parent = self.manifest[family][conv['parent_id']]['id']
        source = {'comment': row, 'conversation': conv}
        obj = self.api('timeline-entries.create', {'type': 'timeline_comment', 'object': parent,
            'external_ref': PREFIX + row['comment_id'], 'body': self.body(source, 'pm_json_data/comments.json', row['body']),
            'visibility': 'internal'})['timeline_entry']
        return self.save('comments', row['comment_id'], obj, parent=parent)

    def run_family(self, family, rows, key, create, workers, limit=None):
        pending = [r for r in rows if r[key] not in self.manifest.get(family, {})]
        if family in ('issues', 'tickets', 'opportunities') and pending:
            # Recover the bounded in-flight batch from an interrupted run before creating anything.
            refs = [PREFIX + r[key] for r in pending[:100]]
            recovered = self.api('works.list', {'external_ref': refs, 'limit': 100})['works']
            for obj in recovered:
                source_id = obj['external_ref'].removeprefix(PREFIX)
                self.save(family, source_id, obj)
            pending = [r for r in pending if r[key] not in self.manifest.get(family, {})]
        if limit is not None:
            pending = pending[:limit]
        print(json.dumps({'family': family, 'remaining': len(pending), 'already_imported': len(self.manifest.get(family, {}))}), flush=True)
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            tasks = iter(pending)
            futures = {pool.submit(create, row) for row in list(__import__('itertools').islice(tasks, workers))}
            count = 0
            last = time.time()
            while futures:
                done, futures = concurrent.futures.wait(futures, timeout=15, return_when=concurrent.futures.FIRST_COMPLETED)
                for future in done:
                    future.result()
                    count += 1
                    row = next(tasks, None)
                    if row is not None:
                        futures.add(pool.submit(create, row))
                if time.time() - last > 20:
                    print(json.dumps({'family': family, 'imported': len(self.manifest.get(family, {})), 'session_created': count}), flush=True)
                    self.checkpoint()
                    last = time.time()
        self.checkpoint()
        print(json.dumps({'family': family, 'total_imported': len(self.manifest.get(family, {}))}), flush=True)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', default=str(HERE / 'data.zip'))
    parser.add_argument('--phase', choices=['accounts', 'contacts', 'issues', 'tickets', 'opportunities', 'works', 'demo', 'articles', 'comments'], required=True)
    parser.add_argument('--workers', type=int, default=24)
    parser.add_argument('--limit', type=int)
    parser.add_argument('--active-only', action='store_true', help='For opportunities, skip closed-won and closed-lost history.')
    args = parser.parse_args()
    if args.active_only and args.phase != 'opportunities':
        parser.error('--active-only is supported only with --phase opportunities')
    imp = Importer(args.archive)
    if args.phase == 'accounts':
        imp.run_family('accounts', imp.rows('crm_json_data/accounts.json'), 'account_id', imp.account, 4, args.limit)
    elif args.phase == 'contacts':
        rows = [r for r in imp.rows('crm_json_data/users.json') if r.get('account_id')]
        imp.run_family('contacts', rows, 'user_id', imp.contact, 4, args.limit)
    elif args.phase == 'articles':
        metadata = ['crm_json_data/users.json', 'pm_json_data/users.json', 'pm_json_data/conversations.json',
                    'pm_json_data/comments.json', 'maple_kb/articles.json', 'transcripts/transcripts.json',
                    'internal_docs/msa_and_compliance.json']
        rows = [{'path': n} for n in imp.archive.namelist() if n.endswith(('.md', '.txt')) and not n.endswith('CANARY.md') or n in metadata]
        imp.run_family('articles', rows, 'path', imp.article, 4, args.limit)
    elif args.phase == 'comments':
        imp.run_family('comments', imp.rows('pm_json_data/comments.json'), 'comment_id', imp.comment, 4, args.limit)
    elif args.phase == 'demo':
        rows = [r for r in imp.rows('crm_json_data/tickets.json') if r['status'] == 'open']
        imp.run_family('tickets', rows, 'ticket_id', lambda r: imp.work('tickets', r), 4, args.limit)
    else:
        for family in (['issues', 'tickets', 'opportunities'] if args.phase == 'works' else [args.phase]):
            source = ('pm' if family == 'issues' else 'crm') + '_json_data/' + family + '.json'
            key = {'issues': 'issue_id', 'tickets': 'ticket_id', 'opportunities': 'opportunity_id'}[family]
            rows = imp.rows(source)
            if args.active_only:
                rows = [r for r in rows if r['stage'] not in ('closed_won', 'closed_lost')]
            imp.run_family(family, rows, key, lambda r: imp.work(family, r), args.workers, args.limit)

if __name__ == '__main__':
    main()
