# Ripple interactive architecture

Existing Site: https://ripple-demo-architecture.pearlyperch6.chatgpt.site/

Editorial, buildless HTML/CSS/JavaScript. This update uses the imported Enterprise-Bench Maple Payments source scenario and preserves the Site's public audience.

## Interactions

- Four outcome → evidence → impact → plan steps, with accessible arrow/Home/End tab navigation.
- Exact source excerpts in a keyboard-accessible dialog.
- Remove the existing investigation to see a narrower recommendation.
- Review and reset an explicitly simulated approval. No real work is created.
- Search/filter the imported inventory and inspect native mapping limits.
- Compare seven integration options with purpose, setup, effort, and current status.
- Explore five stages of the proposed agent and download both handoff documents.

`dist/snapshot.json` is a static source-derived snapshot, not a runtime DevRev connector. Generated task plans are proposed outputs, not historical evidence. There are no browser credentials, customer messages, or production payment actions.

From the repository root:

```sh
python3 scripts/prepare_site.py
node --check sites/ripple-demo/dist/app.js
python3 -m http.server 8765 --directory sites/ripple-demo/dist
```

The preparation script uses the archive fingerprint, manifest, and retained-scope inventory report to regenerate public-safe excerpts and copies of the documents. The public benchmark is the only business source. `.openai/hosting.json` retains the existing project ID. Publish using the Sites source helper, then save/deploy the returned exact commit/archive. Do not commit nested `.git` metadata into the parent GitHub repository.
