# Native Ripple implementation update

The issue brief, cited graph, owner selection and whole-plan approval are implemented in [apps/ripple](../apps/ripple/README.md), with a v2 internal-ticket executor and durable PostgreSQL storage. Start from ISS-42; the Brazil proposal creates one ticket containing three investigation sections. V1 issue fixtures remain under `contracts/v1` for compatibility only. The agent endpoints and live-read local browser are integrated. Hosted service/database, delegated deployment credentials and Team01 component/second-user verification remain deployment work. No new DevRev records were created by the local implementation checks. The earlier status/design notes below are historical; the v2 contract is authoritative for new executable plans.

---

# Ripple: data and integration handoff

Updated 10 October 2026. This is the record of completed work and the integration plan. The agent build guide is [agent-build-guide.md](agent-build-guide.md). Original product intent remains in [idea.md](../idea.md); the decisions below reflect the later discussion.

## Product decisions

Ripple starts with a business outcome or a reported problem. It identifies the relevant product parts, customers, people, history, and constraints. It then prepares a cited investigation or action plan. A person reviews the plan before Ripple writes work items. DevRev is the primary context and action platform.

We have two developers and an existing DevRev workspace. The earlier 12-hour limit was withdrawn. We prefer a complete, repeatable demo to a large list of shallow connectors. No external connector workspace has been provisioned by this work.

The original payment latency story was an illustration. We did not verify a shared payment worker or a decision six months ago to keep its configuration after duplicate renewals. Do not present those claims as Maple Payments history. The source-supported demo is **“Restore Brazil subscription renewals without double billing.”**

## Work completed

1. Reviewed the Ripple vision and the DevRev hackathon material. Investigated the connected DevRev workspace with MCP. The needed Enterprise-Bench company data was not available in sufficient form for the proposed demo, so we imported the supplied Maple Payments dataset.
2. Downloaded the public Enterprise-Bench archive. Inspected its CRM, product, knowledge, internal-document, and discussion exports. Kept the original ZIP and a source-to-native ID manifest.
3. Used DevRev MCP for early product/work/article creation and search validation. Used authenticated REST for the larger resumable import and for account/opportunity operations. These are separate authenticated connections.
4. Resolved the local REST credential issue by loading `DEVREV_PAT` from the untracked `.env`. An earlier HTTP 401 came from an empty local environment value. It was not evidence that the connected MCP credential or the user's PAT was invalid. No token is included in this repository.
5. Imported the product hierarchy, accounts, customer contacts, all issues, an initial ticket set and part of the closed backlog, documents, source directories, and discussion comments. Published the articles with searchable extracted content.
6. The user first selected the full benchmark, then stopped the large ticket import. Kept the completed records. The remaining closed ticket backlog and closed opportunities are outside the current native scope. Do not resume them by default.
7. Imported all **30 active opportunities**. Verified every account link, amount, currency, stage, target close date, external reference, and original JSON record. Corrected two GBP values that initially used the native USD default; the importer now supplies amount and currency together.
8. Checked the Brazil demo's source/native IDs and DevRev search results for subscription, retry, and churn guides. Created an editorial architecture site; this update replaces its earlier hypothetical company/history with the imported dataset, coverage, integration decisions, and agent plan.
9. Added this handoff, an agent build guide, and a verification script for the retained import scope. The site is an interactive architecture/demo preview. It does not execute DevRev writes.

## Source and environment

| Item | Value |
|---|---|
| Workspace | [Hack Midwest 2026 Team01](https://app.devrev.ai/hack-midwest-2026-team01-a016028f) |
| DevRev organization ID | `1mWckJhGyy` |
| API base | `https://api.devrev.ai/` |
| Company | Maple Payments, from Enterprise-Bench |
| Original archive | [devrev/enterprise-bench data.zip](https://github.com/devrev/enterprise-bench/blob/main/artifacts/data.zip) |
| Local archive | `imports/maple-payments/data.zip` |
| SHA-256 | `24d6d134067ffc763c953fab8ec28022c98bb4da11aa0e4456798d7f9bb656bc` |
| Site | [Ripple demo architecture](https://ripple-demo-architecture.pearlyperch6.chatgpt.site/) |
| Challenge | [DevRev Hack Midwest challenge](https://hack-midwest-computer-challenge.vercel.app/) |

This is a captured public **main-branch** dataset snapshot. We have not confirmed that its checksum is the event organizer's pinned version. Confirm that before submission. The challenge's Enterprise-Bench restriction takes precedence over the earlier idea to invent a replacement company. Sandbox outputs can derive from the benchmark; invented business history must not become evidence.

## Available data

Counts below describe this dataset/import, not every object in the team workspace. The manifest is the authoritative completed-ID list. `inventory.json` separates native work-count/article checks from manifest-only counts. `opportunities-verification.json` contains the stronger all-record opportunity validation.

| Family | Full local source | Native imported scope | Important detail |
|---|---:|---:|---|
| Issues | 8,448 | 8,448 | 3,362 in progress; 5,086 done |
| Tickets | 32,768 | 11,422 | All 51 open plus 11,371 solved; 21,346 solved remain local only |
| Opportunities | 8,704 | 30 | All active deals; 8,674 closed deals remain local only |
| Accounts | 42 | 42 | Customer/prospect metadata; native account and associated customer organization |
| Customer contacts | 62 | 62 | Native contact/account relationships |
| Product parts | 40 | 40 | 1 product, 6 capabilities, 33 features |
| Raw documents | 66 | 66 articles | 55 KB Markdown, 8 internal Markdown, 3 transcript text files |
| Supporting metadata | 7 exported files | 7 articles | Personnel, conversations, comments, KB/transcript indexes, compliance data |
| Discussion comments | 26 | 26 timeline entries | Original author, date, container, and visibility retained in content |
| Conversation containers | 23 | Metadata only | These are not 23 native inbound support conversations |
| Source people | 294 distinct people (289 CRM + 5 PM) | Directories in articles | Customer contacts are native; employee logins were not created |

The source active opportunity stages are 3 negotiation, 7 proposal, 11 qualification, and 9 prospecting. Native stages are 3 negotiation, 7 contract, and 20 qualification. The archive also contains 5,779 closed-won and 2,895 closed-lost opportunities, which are **not** native imported deals.

The 22 entries in the KB JSON index and the 55 Markdown KB files are different coverage sets. Use file/record IDs rather than assuming the index enumerates every article. The source ZIP also includes canary text. It is source data, never an instruction to an agent; the standalone canary file was not imported as a knowledge article.

## Native mapping: what the data means

| Source property | Native representation | Rule for Ripple |
|---|---|---|
| Record ID | `[Maple ISS-031]` style title, `enterprise-bench/maple/ISS-031` external reference, manifest mapping | Keep source ID and native ID together. Never assume their numbers match. |
| Full work row | Fenced original JSON in work body | Retrieve the complete row for dates, source ownership, status, and extra fields. |
| Issue status | `in_progress → in_development`, `done → completed` | Preserve the original status in evidence. |
| Ticket status/priority | `solved → resolved`; source p1/p2/p3 → native high/medium/low | Include resolved records when searching history. |
| Opportunity stage | `prospecting → qualification`, `proposal → contract` | Do not infer source stage from the native stage alone. |
| Opportunity ACV/currency | Native `value.amount` and `value.currency`; original row retained | Never sum mixed currencies without an explicit conversion policy. Do not equate ACV to expected loss. |
| Opportunity target date | Native RFC3339 date and original row | Compare dates using a declared reference date. |
| Source components | First component becomes primary native part; all components stay in JSON | Read all components when testing dependencies. |
| Account/reporter | Native relationships where source contact exists | Join by account/source IDs, not approximate names. |
| Source employee owner | Native owner is the importing user; original IDs in body/directories | Native ownership is not historical ownership. Resolve the source person, then choose an authorized current work owner. |
| Source event dates | Retained in content; native created/modified time is import time | Use source time for history. Show retrieval time separately. |
| Account domain | Native unique domain when possible | Two `defense.gov` accounts remain distinct; one lacks the duplicated native domain. Original domains remain in content. |
| Discussions | Internal native comments plus metadata articles | Original source visibility is recorded, not fully recreated as access control. |
| Documents | Published internal articles with content resource and extracted text | Scope, search visibility, and citation text require validation for the second user. |

Source fields such as story points, ticket channel/type, account commercial details, contracts, ARR, SLAs, department, region, and some source relationships remain in JSON/text. Their presence does not mean native reports have corresponding structured fields. Opportunity product-part association was not retained by the API; use its account link and source context. No causal ticket-to-issue links were invented.

Original employees are reference data. They have no new DevRev login or invitation. The CRM and PM directories have no overlapping source IDs: 294 distinct people. Every people ID referenced by the full source work exports resolves in those directories. This does not establish manager completeness or current workspace authorization; missing managers or authorization must remain explicit.

## Strong demo, with exact evidence

**Input:** Restore Brazil subscription renewals without double billing.

| Source record | Native ID | Evidence |
|---|---|---|
| `ISS-031` | `ISS-42` | South America scheduler instability after an infrastructure migration; proposes routing to US-East. Acceptance criteria include automatic replay, webhooks, under 2% renewal failure, no data loss, and no double billing. |
| `TKT-124`, `ACC-001` | `TKT-50` | TechFlow Payments: Brazil renewals become past due; manual charges work; US/EU unaffected. |
| `TKT-125`, `ACC-002` | `TKT-52` | GlobalCommerce Solutions: no payment attempts or failure webhooks; requests ETA and automatic retry. |
| `TKT-126`, `ACC-005` | `TKT-53` | GlobalMart: Brazil renewals fail; manual charges work; requests automatic retry. |
| `PART-003` | `CAPL-4` | Shared subscription capability for the issue and three tickets. |
| Retry/dunning guide | `ART-55` | `[Maple] Failed Payment Retry Logic & Dunning Strategy` |
| Billing guide | `ART-15` | `[Maple] Maple Billing - Subscriptions & Recurring Payments` |
| Churn guide | `ART-36` | `[Maple] Churn Metrics & Subscription Lifecycle Reporting` |

Issue source date: 20 March 2026, updated 24 March. Tickets: 20–21 March. The demo replays a source scenario; it is not a live incident observed in October. Shared part plus similar symptoms supports investigation linkage. It does not prove code-level causality. The source issue states a diagnosis; we have no running scheduler, actual queue metrics, source repository, or deployment logs to verify it independently.

The memorable result is: **“Manual charges work. The reports point to scheduled renewals. An existing issue calls for rerouting and replay, with a no-double-billing requirement. Validate replay safety before acting.”**

Prepare three scoped tasks: verify scheduler/retry behavior; validate routing, replay, and idempotency; prepare customer updates tied to the three reports. Reuse `ISS-42` as existing incident context. Do not create a second generic incident. Customer updates remain drafts unless sending is explicitly approved. A cited account/deal join can add commercial context; it cannot establish a causal revenue-loss estimate.

## Find this in the DevRev UI

Open the workspace link above. Use global search (`Cmd+K` / `Ctrl+K`) and exact native IDs or the source prefix:

- `ISS-42` or `Maple ISS-031` for the investigation.
- `TKT-50`, `TKT-52`, `TKT-53` for the customer reports.
- `Maple Payments Platform` for the product tree; `CAPL-4` for subscription context.
- `[Maple] TechFlow Payments Inc` for an account.
- `Maple OPP-001` for an active opportunity.
- `[Maple] Failed Payment Retry Logic` for a document.

Use Issues and Tickets views where available. Include closed/completed/resolved stages to inspect history. The account/opportunity navigation varies with enabled workspace features; global search avoids that dependency. In each work record, inspect **Original record** for source time and ownership. Search indexing may lag. Direct native-ID lookup is the fallback.

## Integration choices and setup

**Recommended first slice:** native DevRev context and approved DevRev actions, packaged as a reusable Computer skill. Add one small custom evidence MCP only if native retrieval cannot reliably resolve source metadata/citations. Add an external destination after the end-to-end DevRev flow works.

| Integration | Outcome-driven use | Implementation route | New setup / effort | Status |
|---|---|---|---|---|
| DevRev native records | Find incident, customer impact, docs, existing work; create approved investigation tasks | Native Computer tools and skill. Validate available read/create/link tools and their schemas in this workspace. Use server-side REST adapter if a required operation is absent. | Existing workspace; lowest setup burden | Dataset imported; agent workflow not built |
| Source metadata gateway | Resolve original people/time, exact excerpts, complete rows; reconcile coverage | Remote authenticated Streamable HTTP MCP with bounded `search_evidence`, `get_evidence`, `resolve_source_identity`. Read archive/manifest or native content. | HTTPS service, token, admin registration, second-user auth; modest | Proposed |
| GitHub sandbox | Store approved investigation briefs or follow-up issues with evidence links | Check the DevRev Marketplace MCP connector first. AirSync/custom snap-in is a separate synchronization option; validate object support. Otherwise a narrow GitHub API tool in our gateway. | One repository is enough; OAuth/PAT, member access, source↔output IDs | Not connected; optional next destination |
| Jira sandbox | Coordinate approved work with a team that needs Jira | Check Marketplace connector or native AirSync integration. Confirm bidirectional behavior and required project/issue fields. Otherwise a narrow approved issue-create tool. | Jira site/project, users, scopes, issue types, field mapping; greater burden than one GitHub repo | Not connected; defer unless demo needs this handoff |
| Slack | Deliver an approved, cited coordination message | Verify a native connector's read/send scope. Treat benchmark transcripts as source; use Slack only as an output destination for this demo. | Workspace/app/channel, approvals, membership; no outbound messages yet | Not connected; optional output, not a source of invented history |
| Docs/Drive | Publish an approved incident brief | Existing 73 DevRev articles already serve source docs. Add Drive only for a demonstrated output need through an available connector or narrow API tool. | Folder/service access, document IDs, sharing policy | Native articles ready; external docs not connected |
| Queue/code/observability | Validate current runtime behavior | A real authorized read adapter would be needed. Benchmark alone supplies no running system. | Requires code/runtime/log access and approved source rules | Missing; report the gap, never simulate measurements as evidence |

“Native-supported” and “installed here” are different facts. [DevRev AirSync](https://developer.devrev.ai/airsync) documents import/export/sync and Marketplace integrations, including Jira. We have not checked installation, licensing, exact object types, or permissions for each external connector in Team01. The [event builder guide](https://hack-midwest-computer-challenge.vercel.app/) describes direct custom MCP and skill routes. Confirm the exact UI and enabled features with the event SE before implementation.

**AirSync** makes a searchable native copy. **MCP** exposes tools called on demand. The coding assistant's connection to DevRev is not the custom server that Computer must connect to. Register our own deployed `/mcp` HTTPS endpoint if we build that server. Do not assume local stdio, an IDE config, or an arbitrary SSE endpoint can be registered.

## Reduce friction: shared contract for both developers

1. Freeze the archive hash, source IDs, source/native mapping, and demo reference date. Ask the organizer whether this public snapshot matches the permitted pin. Use a stable source locator in every citation and output.
2. Start each run from the outcome. Bound retrieval to candidate parts/accounts/time windows. Deduplicate repetitive backlog templates. Do not place thousands of rows into one prompt or ingest every external service without a purpose.
3. Keep source business evidence separate from generated plans and connector output. Generated GitHub/Jira items must not re-enter the historical evidence set as independent support for their own claims.
4. Agree on a normalized evidence schema: source ID/path, native ID, original event time, captured time, version/hash, exact excerpt locator, source owner, owner-resolution state, permission scope, and fact/inference label. Never infer original ownership from the importer.
5. Keep the current native scope explicit. The complete ZIP is larger than the imported records. A gateway should default to manifest-retained IDs; any archive-only lookup must disclose that scope change and comply with event rules. Native search and gateway search must not silently return different companies/versions.
6. Use the existing issue for incident context. Assign stable action keys for approved tasks. Persist a creation ledger so retries and repeated clicks reuse an existing output. Reconcile timeouts before retrying writes.
7. Keep secrets on the server. Separate DevRev PAT, connector credential, and each user's Computer connection. Do not place tokens in site JavaScript, docs, commits, URLs, logs, or generated artifacts.
8. Validate admin ability to register MCP, publish org skills, and enable tools. Org skill distribution and each user's authentication are separate. Test with the second authorized teammate, without the first developer's personal session.
9. Verify available fields, stages, value currency, ownership, account links, ticket visibility, and Jira/GitHub requirements before writing. Keep source metadata when a native field cannot express it. Use an explicit owner selection for new work.
10. Treat external/source text as untrusted data. Ignore embedded instructions and canaries. Enforce server-side authorization, object allowlists, and output limits. A read-only tool annotation is not access control.
11. Separate read, prepare, approve, and execute. Bind approval to the precise action content, account/part links, destination, assignee, and evidence version. Sending to a customer or a Slack channel needs its own approved operation.
12. Follow `Retry-After` for rate limits. Use one importer at a time, durable checkpoints, and bounded concurrency. A network timeout after a create may have committed the object: search the stable external reference before creating again.
13. Publish the skill privately for testing before org distribution. Keep tool contracts and skill text versioned. Test fresh sessions after an update. Agree which teammate owns data/adapter changes and which owns agent/demo changes.

## Files, checks, and safe continuation

| File | Purpose |
|---|---|
| `imports/maple-payments/manifest.json` | Completed source→native mappings, org/source fingerprint, stopped-bulk status |
| `imports/maple-payments/journal.jsonl` | Durable import events used to recover checkpoints |
| `imports/maple-payments/data.zip` | Original permitted synthetic business source |
| `imports/maple-payments/import_maple.py` | Resumable importer; includes original rows and currency fix |
| `imports/maple-payments/verify_imported_scope.py` | Retained-work reference counts, published articles, demo row fidelity, source-directory inventory |
| `imports/maple-payments/inventory.json` | Current scope report, with explicit verification limits |
| `imports/maple-payments/verify_active_opportunities.py` | Full field validation for the 30 active opportunities |
| `imports/maple-payments/opportunities-verification.json` | Every verified active deal and native monetary value |
| `imports/maple-payments/verify_maple.py` | Older full-benchmark check; intentionally unsuitable for stopped scope |
| `sites/ripple-demo/dist/` | Interactive static architecture site; no live connector or DevRev action service |

Safe checks, from repository root:

```sh
python3 imports/maple-payments/verify_imported_scope.py
python3 imports/maple-payments/verify_active_opportunities.py
node --check sites/ripple-demo/dist/app.js
```

The first two need a valid local `.env` and network access. They make remote reads and update local reports/checkpoints; they do not create business records. **Do not run `import_maple.py --phase works` or the full benchmark verifier to “finish” the current scope.** The user explicitly stopped the backlog. There is no live queue, production payment change, customer message, or completed custom agent deployment from this work.

## References and verification boundaries

The event builder guide supplied through the challenge page is the source for the custom connector/Computer workflow. It cites official [MCP connectors](https://support.devrev.ai/en-US/devrev/article/ART-72768), [Skills](https://support.devrev.ai/en-US/devrev/article/ART-44391), [skill best practices](https://support.devrev.ai/en-US/devrev/article/ART-44392), [agent admin settings](https://support.devrev.ai/en-US/devrev/article/ART-85118), and [Personal Computer](https://support.devrev.ai/en-US/devrev/article/ART-84895). Those support pages were not directly readable through our web tool, so do not treat their current workspace UI or connector capabilities as independently verified. Use the guide plus an SE/workspace check.

Primary engineering references: [Enterprise-Bench](https://github.com/devrev/enterprise-bench), [data schema](https://github.com/devrev/enterprise-bench/blob/main/docs/data-schema.md), [official MCP Python SDK v1](https://github.com/modelcontextprotocol/python-sdk/tree/v1.x), and [DevRev AirSync](https://developer.devrev.ai/airsync). The actual import and verification reports, rather than connector marketing, establish the available native data.
