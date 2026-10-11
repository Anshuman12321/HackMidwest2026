# Ripple hosted status contract: POST /native/status

Server-to-server endpoint on the hosted Ripple app (`RIPPLE_PUBLIC_URL`), called by the snap-in launcher card.
It needs no access-code cookie and has no Origin check. It is read-only and never returns evidence content or tokens.

## Request

`POST {RIPPLE_PUBLIC_URL}/native/status`, `Content-Type: application/json`, body `{"issue": "<issue DON>"}`. The snap-in reads the DON from the snap-kit event's `payload.object_id`.

Headers:

- `Authorization: Bearer <DevRev actor session token>` (`event.context.secrets.actor_session_token`). The server calls `dev-users.self`
  with this token (user must be active and in the workspace), then `works.get` on the issue with the same token.

There is no shared-secret proof. An earlier version signed an `X-Ripple-Bridge` header with a developer keyring, but DevRev never
delivered that keyring to the function (see `docs/ripple-hosted-decisions.md`, challenge C5 and decision S3). The endpoint is
read-only and returns status only, so the verified actor token is the access check.

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

- 403 `permission_denied`: token rejected by DevRev; user inactive or in another workspace; issue unreadable or in another workspace.
- 401 `unauthorized`: missing `Authorization: Bearer` header.
- 400 `invalid_request`: body is not JSON with a string `issue`.
- 503 `not_configured`: the native gateway cannot verify members.

On any failure the card still renders **Open in Ripple** with "Ripple status unavailable right now." and logs one line
(`ripple_status_failed <message>`, never secrets) to the snap-in function logs.
