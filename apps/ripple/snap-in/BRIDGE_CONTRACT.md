# Ripple hosted bridge contract: POST /native/status

Server-to-server endpoint on the hosted Ripple app (`RIPPLE_PUBLIC_URL`), called by the snap-in launcher card.
It needs no access-code cookie and has no Origin check. It is read-only and never returns evidence content or tokens.

## Request

`POST {RIPPLE_PUBLIC_URL}/native/status`, `Content-Type: application/json`, body `{"issue": "<issue DON>"}` (the exact raw bytes are hashed).

Headers:

- `X-Ripple-Bridge`: `Secrets(RIPPLE_BRIDGE_SECRET).sign({ path: '/native/status', hash: sha256hex(rawBody), timestamp: Date.now() }, 'bridge')`.
  Same format as `src/bridge.ts` / `src/http.ts`. Valid for 60 seconds. `RIPPLE_BRIDGE_SECRET` is at least 32 characters and is
  a different secret from `RIPPLE_SECRET`.
- `Authorization: Bearer <DevRev actor session token>`. The server calls `dev-users.self` with this token (user must be active and in
  the workspace), then `works.get` on the issue with the same token.

## Response 200

```json
{
  "issue": { "id": "don:core:...:issue/42", "display_id": "ISS-42", "title": "..." },
  "status": "none | review | approved | rejected",
  "revision": 1,
  "ticket": { "display_id": "TKT-7", "url": "https://app.devrev.ai/<org>/works/TKT-7" },
  "open_url": "https://<ripple host>/?issue=<urlencoded DON>"
}
```

- `status` is from the latest hosted plan for the workspace and issue (any actor); `none` means no review yet (`revision` is null).
- `ticket` is the first created or reused ticket of an approved plan, else null. `ticket.url` is null unless `DEVREV_APP_URL` is set.
- `open_url` opens the web app on this issue (the user signs in there with the access code).

## Errors

- 403 `permission_denied`: bad, missing, stale (over 60s) or wrong-path proof; body hash mismatch; token rejected by DevRev; user inactive or in another workspace; issue unreadable or in another workspace.
- 401 `unauthorized`: missing `Authorization: Bearer` header (checked after the proof).
- 400 `invalid_request`: body is not JSON with a string `issue`.
- 503 `not_configured`: server has no `RIPPLE_BRIDGE_SECRET`.
