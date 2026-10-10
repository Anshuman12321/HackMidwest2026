# Maple Payments in DevRev

Workspace: [Hack Midwest 2026 Team01](https://app.devrev.ai/hack-midwest-2026-team01-a016028f).

This import uses the public Enterprise-Bench Maple Payments archive from
[devrev/enterprise-bench](https://github.com/devrev/enterprise-bench/blob/main/artifacts/data.zip).
It does not add invented business evidence. The local `data.zip` is the exact source snapshot.
Its SHA-256 is `24d6d134067ffc763c953fab8ec28022c98bb4da11aa0e4456798d7f9bb656bc`.
This is a public main-branch snapshot, not a claim that the event team pinned this version.

## Find the data

Open the workspace and use global search (`Cmd+K` on Mac, `Ctrl+K` on Windows).
Search for `Maple` or an exact source-ID prefix such as `Maple ISS-031`.
DevRev assigns new display IDs; source IDs remain in titles and record content.
`manifest.json` maps each source record to its native DevRev ID.

- Issues: use the Issues view, or search for `Maple ISS-031`.
- Tickets: use the Tickets view, or search for `Maple TKT-124`.
- Accounts: search for `[Maple] FinPago Brasil` or `[Maple] TechFlow Payments Inc`.
- Opportunities: search for `Maple OPP-001`.
- Parts: search for `Maple Payments`; open its product hierarchy.
- Articles: search for `[Maple] Overview of Maple Payments Platform`, `retry`, or `subscription`.

Include closed/resolved stages when browsing the full background dataset. Default active-only views
will hide most tickets and many issues and opportunities. Search indexing can lag behind creation.

The Brazil renewal demo uses source `ISS-031` (native **ISS-42**) and source tickets
`TKT-124`, `TKT-125`, and `TKT-126` (native **TKT-50**, **TKT-52**, and **TKT-53**).
They share the subscription capability (**CAPL-4**). The tickets point to TechFlow Payments,
GlobalCommerce Solutions, and GlobalMart respectively. Shared product context is preserved;
the import does not invent causal ticket-to-issue links.

DevRev MCP search was checked after import. A query about renewals and dunning returned
the published retry strategy (**ART-55**), billing/subscriptions guide (**ART-15**),
and churn reporting guide (**ART-36**), with their source content available as evidence.

## Current scope

The user stopped the bulk ticket load on October 10, 2026. The saved import contains all 8,448
issues, 11,422 tickets (including all 51 active tickets), 42 accounts, 62 customer
contacts, 40 parts, 73 articles, 26 comments, and all 30 active opportunities. The remaining closed
ticket backlog and the closed opportunity backlog are not loaded. `manifest.json` records the
exact completed source IDs. `inventory.json` records a fresh retained-scope native count check and publication checks for all 73 articles. `opportunities-verification.json` records checks of all 30 active deals
against their source account, value, stage, target close date, and original content.

The full source archive remains available locally. The table below describes source inventory,
not completed native import totals.

The full source contains:

| Source | Records |
|---|---:|
| Issues | 8,448 |
| Tickets | 32,768 |
| Opportunities | 8,704 |
| Accounts | 42 |
| Customer contacts | 62 |
| Product parts | 40 |
| Markdown/text documents | 66 |
| Supporting metadata articles | 7 |
| Work timeline comments | 26 |

The 23 source conversation containers are preserved in their metadata article and in comment
provenance. They represent issue/ticket discussions, so comments attach to those native work items.
They are not fabricated inbound support conversations.

## Mapping and limits

Each work body includes the complete original JSON row, with source dates, people, status, and
components. Native creation/modification timestamps reflect import time. Native employee ownership
uses the importing user; original employees and ownership IDs remain in the source personnel article
and work content. The import does not create employee login accounts or send invitations.

Issues map `in_progress` to `in_development` and `done` to `completed`. Tickets map `solved` to
`resolved`. Opportunity `prospecting` maps to `qualification`, and `proposal` maps to `contract`;
other source pipeline stages use their corresponding native names. Original stages remain explicit.
Source ACV and currency are stored in the native opportunity value and in the original row. The first source
component is the native primary part; all components are retained in the original row.
Customer accounts and reporters are native relationships where source contact records exist.

DevRev requires unique account domains. The two source accounts with `defense.gov` remain distinct;
the shared source domain is preserved in account content. Imported comments are internal and retain
their original source visibility, author, and date in provenance. The source directory includes all
CRM and PM people as reference data without granting them workspace access.

For Ripple, use the source historical dates and ownership metadata when reasoning about earlier
decisions. Do not treat the native import date or importing user as the original event date or owner.

## Import tools

The bulk import was stopped at the user's request. Do not run the `--phase works` command
below unless the user requests the full backlog again. The full-coverage verification script
also expects every source work record; it is not a completion check for this reduced scope.

Run these commands from the project root. `.env` holds `DEVREV_PAT` and is excluded from Git.
The script checks that the token matches the recorded importing user and organization.

```sh
python3 imports/maple-payments/verify_imported_scope.py
python3 imports/maple-payments/import_maple.py --phase accounts
python3 imports/maple-payments/import_maple.py --phase contacts
python3 imports/maple-payments/import_maple.py --phase articles
python3 imports/maple-payments/import_maple.py --phase opportunities --active-only --workers 4
python3 imports/maple-payments/verify_active_opportunities.py
python3 imports/maple-payments/import_maple.py --phase works --workers 32
python3 imports/maple-payments/import_maple.py --phase comments
python3 imports/maple-payments/verify_maple.py
```

Completed source IDs are saved in `journal.jsonl` and periodically checkpointed to `manifest.json`.
Run one importing process at a time. The importer obeys rate-limit retry delays. An ambiguous network
failure stops the import so the affected source references can be checked before resuming.
The older `verification.json` and status `complete_verified` apply only to full-benchmark completion. They are not expected for this intentionally stopped import. Use `inventory.json` for current retained-scope verification and `opportunities-verification.json` for deal field checks.
