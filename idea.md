# Ripple

> Organizational context reconstruction for software teams.

## 1. Purpose of this file

This file is the durable product and implementation reference for Ripple.

Codex and other development agents should use this file to understand:

- what Ripple is;
- what problem Ripple solves;
- what belongs in the hackathon MVP;
- the distinction between the Context Bundle and the Action Graph;
- how validation works;
- how DevRev fits into the system;
- which implementation choices are intentional;
- which features are explicitly out of scope.

When implementation details conflict with this file, prefer this file unless the team has explicitly updated the decision.

---

## 2. Product vision

Software teams often inherit systems without inheriting the reasoning behind them.

The code can show **what exists**, but it often cannot explain:

- why a decision was made;
- which customer or business problem caused the decision;
- which tickets, incidents, conversations, or documents influenced it;
- what assumptions were true at the time;
- which parts of the system depend on the decision;
- what could break if the decision changes.

Ripple reconstructs this missing organizational context.

Ripple ingests evidence from engineering and organizational systems, connects related evidence, and produces a traceable explanation of a software decision or system behavior.

The product then converts that reconstructed context into actionable work.

The long-term goal is to provide a trusted organizational context layer that both humans and AI agents can query before they change a legacy system.

---

## 3. Hackathon thesis

### Core thesis

A developer should be able to ask:

> "Why does this part of the system work this way, and what should I know before I change it?"

Ripple should return:

1. the most relevant historical context;
2. the evidence that supports the explanation;
3. the likely dependencies and affected systems;
4. a proposed course of action;
5. a DevRev work item when action is required.

The system must distinguish between **retrieved facts**, **model-generated inferences**, and **validated conclusions**.

---

## 4. Hackathon scope

The hackathon implementation is intentionally split into two phases.

### Phase 1 — Reconstruct and create work

Phase 1 is the required MVP.

It includes:

1. ingest evidence;
2. normalize evidence;
3. connect related evidence;
4. reconstruct context;
5. produce a Context Bundle;
6. identify dependencies and possible impact;
7. recommend a course of action;
8. create or enrich a DevRev ticket/work item.

### Phase 2 — Validate and expose

Phase 2 is an extension after Phase 1 works end to end.

It includes:

1. validate important claims in the Context Bundle;
2. assign confidence and validation state;
3. construct an Action Graph for a proposed change;
4. expose Ripple context to other tools or agents through MCP or an equivalent interface;
5. optionally support approval or execution workflows.

### Priority rule

If time becomes constrained, protect the complete Phase 1 demo before adding Phase 2 capabilities.

A narrow end-to-end workflow is more valuable than several incomplete integrations.

---

## 5. Primary user

The primary user is a developer entering an unfamiliar or legacy codebase.

Typical situations include:

- the original architect is no longer available;
- a business rule is encoded in old code with little documentation;
- a developer must modify a component but does not know its downstream impact;
- a team sees an incident or customer issue and needs to reconstruct the decisions that produced the current behavior;
- an AI coding agent needs organizational context before proposing a change.

---

## 6. Core user story

> As a developer working in an unfamiliar system, I want Ripple to reconstruct the business and engineering context behind a piece of code or issue so that I can make a change with evidence, understand likely dependencies, and create the correct follow-up work.

---

## 7. Core concepts

### 7.1 Evidence

Evidence is an atomic source item that Ripple can cite.

Examples:

- source-code file or symbol;
- commit;
- pull request;
- DevRev work item;
- issue;
- incident;
- support ticket;
- product requirement;
- design document;
- decision record;
- chat or discussion excerpt;
- release note.

Each evidence item should retain provenance.

Minimum useful fields:

```text
id
source_type
source_system
source_locator
title
content_or_summary
author_or_owner
timestamp
related_entities
metadata
```

Do not discard source identity after ingestion.

---

### 7.2 Context Bundle

A **Context Bundle** is the evidence-backed explanation of the current situation.

It answers:

> "What happened, why does the system look like this, and what evidence supports that explanation?"

A Context Bundle is primarily descriptive.

It should contain:

- the developer's question or trigger;
- a concise explanation;
- relevant historical events;
- business rationale;
- engineering rationale;
- supporting evidence;
- relevant code or system components;
- known constraints;
- likely dependencies;
- unresolved questions;
- confidence;
- validation state.

Example shape:

```json
{
  "question": "Why does checkout retry payment authorization three times?",
  "summary": "...",
  "business_context": ["..."],
  "technical_context": ["..."],
  "evidence": [
    {
      "id": "evidence-123",
      "source": "devrev",
      "locator": "...",
      "claim_supported": "..."
    }
  ],
  "dependencies": ["payments-service", "order-state-machine"],
  "risks": ["duplicate authorization"],
  "open_questions": ["..."],
  "confidence": 0.82,
  "validation_state": "partially_validated"
}
```

The Context Bundle is **not** a task plan.

It is the reconstructed knowledge required to make a good task plan.

---

### 7.3 Action Graph

An **Action Graph** represents the proposed change and the things that may be affected by that change.

It answers:

> "If we take this action, what else must we inspect, update, validate, or coordinate?"

An Action Graph is primarily prescriptive.

Nodes can represent:

- code components;
- services;
- APIs;
- database objects;
- tests;
- owners;
- work items;
- customer-facing behavior;
- dependencies;
- required validations.

Edges describe relationships such as:

```text
depends_on
calls
owned_by
validated_by
blocks
changes
affects
derived_from
requires
```

Example:

```text
Change retry policy
    |
    +--> payment authorization client
    |       |
    |       +--> integration tests
    |
    +--> order state machine
    |
    +--> fraud rules
    |
    +--> support playbook
    |
    +--> DevRev work item
```

The Action Graph is built **from the Context Bundle plus the proposed course of action**.

### Context Bundle vs. Action Graph

Use this rule:

- **Context Bundle = understanding the past and present.**
- **Action Graph = reasoning about a proposed future change.**

Do not merge these concepts into one object.

---

## 8. Validation

Validation is the process used to determine whether important claims in a Context Bundle or Action Graph are sufficiently supported.

Validation does **not** mean that an LLM says a statement is correct.

A claim is stronger when Ripple can confirm it through independent evidence or deterministic inspection.

### Validation methods

Depending on the claim, validation can include:

1. **Source corroboration**
   - Find more than one independent source that supports the claim.

2. **Code inspection**
   - Confirm that a claimed dependency, call path, configuration, or behavior exists in the repository.

3. **Temporal validation**
   - Confirm that evidence existed before or during the decision being reconstructed.

4. **Entity validation**
   - Confirm that referenced work items, files, services, owners, or APIs exist.

5. **Relationship validation**
   - Confirm an inferred relationship through repository structure, references, linked tickets, or other evidence.

6. **Contradiction detection**
   - Identify evidence that disagrees with the reconstructed narrative.

7. **Human validation**
   - Allow a user to approve, reject, or correct an important inference.

### Validation states

Use a small vocabulary:

```text
unvalidated
partially_validated
validated
conflicted
```

### Claim confidence

Confidence should be attached to important claims, not only to the entire response.

Where practical, represent:

```json
{
  "claim": "The retry behavior was introduced to handle PSP timeout failures.",
  "confidence": 0.91,
  "validation_state": "validated",
  "evidence_ids": ["e1", "e4"]
}
```

### Important rule

Never present an inferred rationale as a historical fact without identifying it as an inference.

---

## 9. MVP workflow

The preferred demonstration flow is:

```text
Developer question / selected code / issue
        |
        v
Evidence retrieval
        |
        v
Evidence normalization
        |
        v
Context reconstruction
        |
        v
Context Bundle
        |
        +--> dependencies / impact
        |
        +--> recommendation
        |
        v
DevRev work item
```

Phase 2 extends the flow:

```text
Context Bundle
        |
        v
Claim validation
        |
        v
Validated Context Bundle
        |
        v
Action Graph
        |
        +--> human / agent consumption
        |
        +--> MCP exposure
```

---

## 10. Recommended MVP features

The project should optimize around approximately five visible capabilities.

### 1. Context ingestion

Retrieve relevant evidence from the systems available during the hackathon.

DevRev should be a first-class source.

Additional repository or document sources can be added only when they materially improve the demo.

### 2. Context reconstruction

Given a developer question or selected engineering artifact, reconstruct the most relevant business and technical history.

The result must cite the evidence used.

### 3. Dependency and impact discovery

Identify systems, code components, tickets, owners, or behaviors that may be affected by the issue or proposed change.

Distinguish confirmed dependencies from inferred dependencies.

### 4. Recommendation and DevRev ticketing

Produce a recommended next action and create or enrich a DevRev work item with the reconstructed context.

### 5. Validation and agent exposure

If Phase 1 is complete, validate critical claims and expose trusted context through MCP or an equivalent agent interface.

---

## 11. DevRev's role

DevRev is not only a destination for tickets.

For Ripple, DevRev can serve as part of the organizational context substrate.

Use DevRev for the capabilities that are available and reliable during the hackathon, such as:

- retrieving relevant work items;
- retrieving issue or support context;
- identifying linked entities;
- identifying owners or related product areas;
- creating work items;
- updating work items with reconstructed context;
- linking evidence or related work where supported.

### DevRev integration principle

Wrap DevRev access behind a small adapter.

Do not scatter DevRev-specific API calls throughout the application.

Example interface:

```ts
interface WorkSystem {
  searchEvidence(query: string): Promise<Evidence[]>;
  getItem(id: string): Promise<Evidence | null>;
  createWorkItem(input: WorkItemInput): Promise<WorkItem>;
  updateWorkItem(id: string, input: Partial<WorkItemInput>): Promise<WorkItem>;
}
```

The exact API operations must be confirmed against current DevRev documentation before implementation.

Reference:

`https://developer.devrev.ai/`

Do not hard-code undocumented endpoint names into architecture documentation.

---

## 12. Repository/code context

The repository is another important evidence source.

For the hackathon, keep code analysis simple and deterministic where possible.

Useful operations include:

- file search;
- symbol search;
- text references;
- imports;
- call sites;
- config references;
- test references;
- Git history where available.

Do not attempt to build a full static-analysis platform during the hackathon.

A lightweight repository adapter is sufficient.

Example:

```ts
interface RepoContext {
  search(query: string): Promise<Evidence[]>;
  getFile(path: string): Promise<Evidence>;
  findReferences(symbol: string): Promise<Evidence[]>;
  getHistory(path: string): Promise<Evidence[]>;
}
```

---

## 13. Suggested internal architecture

Prefer a small number of explicit modules.

```text
/apps
  /web-or-cli

/src
  /ingestion
    devrev.ts
    repository.ts

  /context
    normalize.ts
    retrieve.ts
    reconstruct.ts
    bundle.ts

  /validation
    validate-claims.ts
    contradictions.ts

  /impact
    dependencies.ts
    action-graph.ts

  /actions
    recommendations.ts
    devrev-work-item.ts

  /mcp
    server.ts

  /types
    evidence.ts
    context-bundle.ts
    action-graph.ts
```

This is a guide, not a mandatory directory structure.

The important architectural separation is:

```text
ingestion -> evidence -> reconstruction -> Context Bundle
Context Bundle -> validation
Context Bundle + proposed action -> Action Graph
Context Bundle / Action Graph -> DevRev or MCP
```

---

## 14. Data model

### Evidence

```ts
type Evidence = {
  id: string;
  sourceType: string;
  sourceSystem: string;
  sourceLocator: string;
  title?: string;
  content: string;
  timestamp?: string;
  author?: string;
  metadata?: Record<string, unknown>;
};
```

### Claim

```ts
type Claim = {
  id: string;
  text: string;
  type: "fact" | "inference" | "recommendation";
  evidenceIds: string[];
  confidence?: number;
  validationState:
    | "unvalidated"
    | "partially_validated"
    | "validated"
    | "conflicted";
};
```

### ContextBundle

```ts
type ContextBundle = {
  id: string;
  query: string;
  summary: string;
  claims: Claim[];
  businessContext: string[];
  technicalContext: string[];
  evidence: Evidence[];
  dependencies: Dependency[];
  risks: string[];
  openQuestions: string[];
  confidence?: number;
};
```

### Dependency

```ts
type Dependency = {
  id: string;
  name: string;
  kind: string;
  relationship: string;
  evidenceIds: string[];
  confidence?: number;
};
```

### ActionGraph

```ts
type ActionGraph = {
  id: string;
  proposedAction: string;
  nodes: ActionNode[];
  edges: ActionEdge[];
  risks: string[];
  requiredValidations: string[];
};
```

The schemas may change during implementation, but preserve the conceptual boundaries.

---

## 15. Retrieval strategy

Do not send every available artifact to the model.

Use a staged retrieval process:

1. identify the trigger;
2. generate search terms/entities;
3. retrieve candidate evidence;
4. normalize candidates;
5. rank or filter candidates;
6. reconstruct context from the reduced evidence set;
7. preserve citations.

For the hackathon, simple ranking is acceptable.

Possible ranking signals:

```text
direct ID/link match
same code symbol
same service
linked DevRev item
keyword overlap
time proximity
shared owner
shared product area
explicit relationship
```

---

## 16. Model responsibilities

Use the model for tasks that benefit from semantic reasoning:

- query decomposition;
- evidence summarization;
- chronology reconstruction;
- rationale reconstruction;
- claim extraction;
- dependency hypotheses;
- recommendation generation;
- contradiction explanation.

Prefer deterministic code for:

- IDs;
- source provenance;
- links;
- exact timestamps;
- graph storage;
- entity existence;
- file references;
- API requests;
- confidence thresholds;
- validation state transitions.

The model must not invent source references.

---

## 17. Prompting principle

Prompts should require structured output.

A reconstruction prompt should explicitly tell the model to separate:

```text
confirmed facts
supported inferences
unsupported/open questions
recommendations
```

Every important factual or inferred claim should reference one or more evidence IDs.

Example instruction:

```text
For every claim, return the evidence IDs that support it.
If evidence is insufficient, mark the claim as an inference or open question.
Do not invent evidence IDs.
```

---

## 18. Ticket creation

A DevRev work item created by Ripple should be useful even if the recipient never opens Ripple.

Recommended content:

```markdown
## Problem

...

## Reconstructed context

...

## Why this exists

...

## Relevant evidence

- ...
- ...

## Dependencies / possible impact

- ...
- ...

## Recommended action

...

## Risks

...

## Open questions

...

## Ripple confidence

...
```

If DevRev supports richer structured fields or links cleanly, use them.

Do not block the MVP on advanced DevRev customization.

---

## 19. MCP exposure

MCP is a Phase 2 delivery mechanism.

The purpose is to let another AI agent request trusted organizational context before making a change.

Potential tools/resources:

```text
get_context(query)
get_context_for_file(path)
get_context_for_work_item(id)
get_dependencies(entity)
get_action_graph(proposed_change)
```

The exact MCP interface should stay small.

Do not expose raw internal complexity unless a consumer needs it.

A coding agent should be able to ask:

> "What should I know before editing this file?"

and receive a compact, cited Context Bundle.

---

## 20. Sponsor technology opportunities

Sponsor integrations are useful only when they improve the product or demo.

Do not add a sponsor technology only for logo count.

Possible extension points:

### AWS

Good fit if the team needs:

- hosted API or worker execution;
- object storage;
- managed database;
- vector/search infrastructure;
- Bedrock or another managed AI component.

### Akamai

Good fit if the team needs:

- edge deployment;
- API delivery;
- globally distributed application infrastructure;
- security or traffic management.

### Other sponsor technology

A sponsor integration is acceptable when it supports one of these real product needs:

```text
ingestion
retrieval
storage
model inference
validation
deployment
security
agent delivery
```

### Sponsor rule

Do not introduce new infrastructure after the MVP path works unless the integration is low risk.

---

## 21. Non-goals for the hackathon

Ripple is not trying to:

- ingest every enterprise data source;
- build a complete enterprise knowledge graph;
- replace DevRev;
- replace GitHub;
- build a full static-analysis engine;
- autonomously modify production systems;
- guarantee perfect historical truth;
- resolve every organizational contradiction;
- implement a large multi-agent framework;
- build a generalized workflow engine;
- support every MCP consumer.

Avoid architecture that assumes these features must exist for the MVP.

---

## 22. Demo scenario

Prefer one polished scenario over many weak scenarios.

Example:

1. A developer selects a suspicious legacy behavior or asks a question.
2. Ripple retrieves code and DevRev evidence.
3. Ripple reconstructs why the behavior exists.
4. Ripple shows the source evidence.
5. Ripple identifies likely dependencies and impact.
6. Ripple proposes a course of action.
7. Ripple creates a DevRev work item with the reconstructed context.
8. If Phase 2 is ready, Ripple validates key claims and shows the Action Graph.
9. Optionally, an MCP client requests the same context.

The demo must make the "before Ripple" and "after Ripple" contrast obvious.

---

## 23. Success criteria

### Required

The MVP is successful when a user can:

- provide a code/engineering question;
- retrieve evidence from at least DevRev and one code/repository source;
- receive a coherent Context Bundle;
- see evidence linked to the important claims;
- see likely dependencies or impact;
- receive a recommendation;
- create or update a DevRev work item from the result.

### Strong bonus

The system also:

- validates important claims;
- detects conflicting evidence;
- generates an Action Graph;
- exposes context through MCP;
- demonstrates another sponsor technology without weakening the core demo.

---

## 24. Engineering priorities

Use this order when making tradeoffs:

1. end-to-end demo reliability;
2. evidence traceability;
3. clear Context Bundle;
4. useful DevRev integration;
5. dependency/impact quality;
6. validation;
7. MCP exposure;
8. extra sponsor integrations;
9. visual polish beyond what the demo requires.

---

## 25. Reliability rules

### Never fabricate evidence

If a source cannot be found, say so.

### Preserve provenance

Every evidence item should retain enough data to locate the original source.

### Separate fact from inference

Historical explanations are often partially inferred.

Make that distinction visible.

### Prefer graceful degradation

If one source fails, Ripple should still produce the best result possible from the remaining evidence.

### Keep model output bounded

Use structured schemas and validate model output.

### Make the happy path deterministic

The hackathon demo should not depend on several fragile autonomous steps.

---

## 26. Codex operating instructions

When Codex works on this repository, use the following rules.

### Before implementing a feature

Check whether the feature supports:

```text
Phase 1 MVP
Phase 2 extension
or neither
```

If neither, do not prioritize it.

### When changing architecture

Preserve these boundaries:

```text
Evidence
Context Bundle
Validation
Action Graph
Delivery
```

Do not collapse them into one generic "agent" abstraction.

### When adding an integration

Create an adapter with a small interface.

Avoid coupling core domain logic to external SDK types.

### When adding model calls

Require structured output and evidence references.

### When adding UI

Optimize for the demo story:

```text
question
-> evidence
-> reconstructed context
-> dependencies
-> recommendation
-> DevRev action
```

### When uncertain

Choose the smallest implementation that preserves the product thesis and works reliably.

---

## 27. Decision log

### Locked decisions

- Product name: **Ripple**.
- Core problem: reconstruct lost organizational context around software systems and decisions.
- Primary audience: developers working in unfamiliar or legacy systems.
- DevRev is a first-class evidence source and action destination.
- Phase 1 covers ingestion, context reconstruction, dependencies/impact, recommendation, and ticketing.
- Phase 2 covers validation and context/action delivery through MCP.
- Context Bundle and Action Graph are separate concepts.
- Context Bundle describes the relevant past and present.
- Action Graph describes the implications of a proposed future action.
- Important claims must remain traceable to evidence.
- Inferences must not be presented as confirmed historical facts.
- Demo reliability takes priority over feature count.

### Decisions that can remain flexible

- exact framework;
- exact database;
- exact model provider;
- exact vector store;
- exact deployment target;
- exact UI framework;
- exact graph persistence method;
- exact MCP implementation shape.

Do not spend hackathon time debating a flexible decision unless it blocks the MVP.

---

## 28. Open questions

Resolve these only when they become implementation blockers.

- What is the exact primary demo dataset?
- What is the primary user trigger: free-text question, selected file, DevRev work item, or a combination?
- Which DevRev objects provide the highest-value context for the demo?
- How much repository history is available and useful?
- Which dependency relationships can be confirmed deterministically?
- What validation methods can be completed within hackathon time?
- Is MCP required for the final demo, or is it a stretch capability?
- Which sponsor integration, if any, adds real value after the MVP is stable?

---

## 29. One-sentence description

**Ripple reconstructs the organizational context behind software decisions, connects that context to affected dependencies, and turns the result into evidence-backed engineering action.**

---

## 30. Short pitch

Teams lose critical software knowledge when decisions become scattered across code, tickets, incidents, documents, and people.

Ripple reconstructs that missing context.

A developer can ask why a system behaves a certain way. Ripple retrieves relevant engineering and business evidence, rebuilds the reasoning behind the current design, identifies likely dependencies, recommends a next action, and creates the corresponding DevRev work item.

The result is a context layer that helps both developers and AI coding agents change legacy systems with more confidence and less organizational guesswork.
