# Read-only investigation implementation

The investigation agent now uses the v2 `InvestigationResponse` contract shared with the native Ripple UI and executor. The planner emits one internal `create_ticket` action covering scheduler, replay-safety and customer-draft work. Owner selection, storage, approval and execution belong to the UI service.

The integrated local browser flow is documented in [apps/ripple/README.md](../apps/ripple/README.md). `npm run preview:live` reads DevRev using the verified local connector and creates exclusively simulated `PREVIEW-*` tickets. `npm run start:agent` exposes authenticated `/investigate` and `/revalidate` endpoints for actor-delegated production integration; it never falls back to personal connector credentials. Python 3.11+ is required.

Revalidation rereads exact cited work and related native objects and checksum-verified archive bytes, checks the reviewed hashes/excerpts/mappings/joins and supplied digest, and preserves reviewed provenance timestamps. It accepts fresh retrieval timestamps and service-issued plan identity or owner revisions. Source/access changes block approval and execution.

## Run

On this Windows machine, the default Node is version 22. Use the wrapper from
the repo root; it detects the installed Codex Node 24 and Python runtimes:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-investigation.ps1 -CapturePath .local\investigation-capture.json
```

`-NodePath` and `-PythonPath` override that selection on other machines.
Install `contracts` dependencies first with `npm ci` as below.

Use Node 24+ and Python 3.11+. Configure the personal `DevRev` MCP server at
`https://api.devrev.ai/mcp/v1` with the Windows setup script. Credentials are read
inside the Python bridge from `CODEX_HOME/config.toml` or `~/.codex/config.toml`;
they are never sent to the UI, command arguments or generated response files.

```powershell
cd contracts
npm ci
# Set only when the default python command is unavailable or too old:
$env:RIPPLE_PYTHON = 'C:\path\to\python.exe'
npm run investigate -- --outcome "Restore Brazil subscription renewals without double billing."
```

The output defaults to `.local/investigation-response.json` at the repo root.
`.local/` is ignored by Git. `--request <file>` accepts the shared request format;
`--output <file>` changes the response destination. Optional `--capture <file>`
stores the exact adapter sources, schemas and read trace for local revalidation.
Treat that capture as workspace data; do not publish it automatically.

`prepareInvestigation(request, retrieval, now)` and `validateEvidence(response,
retrieval)` in `contracts/investigate.server.ts` can be imported by the other
developer's authenticated server. Invoke the real retrieval adapter in the
authenticated server context; a client-supplied adapter snapshot is not trusted
proof of access. The CLI uses the local credential and does not supply a hosted
multi-user service or authorization layer. The UI/executor owns durable plan
storage, current authorization, owner revisions, approvals and execution.

## Flow and evidence rules

1. Initialize MCP, discover `tools/list` (including pagination), then call
   `discover_schema()` before action/read queries. Require the discovered
   reviewed read tools and their required argument fields.
2. Derive search text and lexical relevance terms from the outcome. Search
   issue and ticket namespaces without stage filters, including resolved work.
   Native part/account/starting-object hints narrow retrieval when supplied.
3. Read bounded candidate IDs through `execute_dql`, requesting full source
   bodies. Verify DON, display ID, source row ID, external reference and manifest
   mapping together. Reject identity mismatches. Do not cite a snippet as a row.
4. Read related native parts and accounts; verify their source identities.
   Source components/account IDs support context joins, never runtime causality.
5. Search documentation by the resolved product topic. If native article bytes
   are unavailable, read at most four matching Markdown guides from the original
   checksum-verified archive. Label these `archive_only`, keep native ID null,
   and declare `imported_and_archive`. An old manifest mapping does not prove
   current article access. No archive fallback for unavailable work is enabled.
6. Preserve exact Unicode code-point offsets, complete source hashes, creation
   dates, issue update dates and historical assignee IDs. Work-row hashes use
   the shared canonical JSON algorithm on the complete original row. For
   Markdown, the complete original record is its unmodified text string; its
   hash is SHA-256 of canonical JSON of that string, and the field path is
   `original_record`. Undated documents retain a null original event time.
7. Build deterministic source-attributed facts, labeled inferences and explicit
   gaps. Treat all embedded source instructions/canaries as data. No source text
   can select a tool, credential, operation or assignee.
8. Generate one internal ticket with scheduler, recovery/replay-safety and customer-draft sections only for
   the supported subscription domain with relevant work and a verified native
   part. Reuse accessible existing issues. Missing incidents cannot support
   their diagnoses or routing proposals. Unsupported outcomes or missing scope
   return `needs_input`, not a canned Brazil plan.
9. Validate with the shared runtime schema, check exact source slices/hashes,
   source dates, native identities and joins, and seal with `sealPlan`. Owners
   remain null. Fresh plans expire after one hour; stable task keys use the
   source incident and task purpose. No write tool is reachable through the
   bridge's allowlist.

Explicit historical reference times filter rows whose creation or latest source
update exceeds the cutoff; undated documents are omitted. This conservatively
excludes a later snapshot instead of inventing an older revision. A historical
cutoff never proves when the benchmark snapshot was available.

## Live verification and tool gaps — 10 October 2026

The outcome, with empty scope hints, retrieved `ISS-031 / ISS-42`,
`TKT-124 / TKT-50`, `TKT-125 / TKT-52`, `TKT-126 / TKT-53`,
`PART-003 / CAPL-4` and the three source/native accounts through MCP. Returned
original rows preserve the 20–21 March source dates and the issue's 24 March
update. This replays benchmark history; it does not observe an October outage.

| MCP capability | Observed behavior / handling |
|---|---|
| `discover_schema`, `tools/list` | Available; schemas are discovered before retrieval. |
| `hybrid_search` for issue/ticket/capability | Finds the intended records and broader candidates; full rows plus outcome terms narrow scope. Search is bounded and not exhaustive. |
| `fetch_object_context` | Useful identity/context read, but the incident body is truncated at 2,000 characters and contains escaped newlines. Do not use this summary for complete-row hashes or exact work citations. |
| `execute_dql` for issue/ticket | Returns complete source bodies when explicitly projecting `body`; supports candidate-ID filters. Used for citation-grade work evidence. |
| Native articles | Hybrid and DQL text searches returned no articles. Direct DQL reads for manifest-mapped subscription articles also returned none, and an `ART-15` context read failed. This establishes an access/retrieval gap, not its cause. Indexing, credential permissions and native article visibility require another authorized reader to verify. |
| Documentation fallback | Retry/dunning, recurring billing, churn/lifecycle and subscription-plan guides were read from the verified archive, with explicit archive-only coverage. No current native article access is asserted. |
| Source people | Original assignee IDs retained; names/current authorization unresolved. Importer ownership is not used for historical identity or new assignment. |
| Runtime observability | No scheduler, queue, payment ledger, code or deployment evidence available. Production recovery remains blocked pending verification. |
| Writes | Zero create/update/link/comment/message calls. The original v1 preview proposed `create_issue` operations as JSON content only; the integrated v2 planner now proposes one internal ticket. |

The first planner is deliberately deterministic and supports subscription
recovery. Lexical relevance filtering may miss paraphrases; the response
discloses bounded coverage. Other domains require an additional reviewed planner,
not hidden hardcoded evidence IDs. Workspace-specific custom schemas must be
rediscovered for each runtime connection. Tests use fixtures and do not establish
the second teammate's current permissions; repeat the CLI with their own MCP
credential before claiming multi-user acceptance.

## Verification

```powershell
cd contracts
npm run check
npm test
cd ..
python scripts/test_retrieval.py
```

Checks cover the valid preview, source identity/hash/excerpt/date tampering,
missing incident/docs/part, conservative as-of filtering, account/part joins,
stable task keys, source canaries and write-tool denial. Live output and its
optional source capture can also be revalidated with `validateEvidence`.
The shared contract was coordinated to v2 during integration; preserved v1 fixtures are under `contracts/v1`.

To verify a saved response against its captured source rows and digest:

```powershell
node contracts/verify-investigation.ts .local/investigation-response.json .local/investigation-capture.json
```

This verifies the captured source bytes, not fresh authorization or runtime state.
The original v1 live preview passed the shared runtime schema and exact-source validation
with 16 citations and three proposed tasks. Type-checking, 28 TypeScript tests
(19 existing contract checks plus 9 agent checks), and 7 offline Python adapter
checks passed. Owners are null and no work was created.
