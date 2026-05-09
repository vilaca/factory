# WebFetch

`WebFetch` is a read-only tool the model invokes to pull a URL into the conversation — usually to read API docs, an error-page traceback, or a referenced blog post. HTML is stripped of boilerplate (nav, scripts, styles, footers) and converted to markdown; `text/plain` and `text/markdown` are returned as-is; other content types come through with a header noting the type.

## Bounds

Every fetch is capped — there is no flag to lift these limits.

| Limit | Value |
| ----- | ----- |
| Body size (raw) | 1 MiB. The fetcher streams chunks and aborts when the cap is exceeded; if the server advertises a `Content-Length` more than 8× the cap, the request is refused before any body is read. |
| Output to model | 16 KiB. Truncation note appended when hit. |
| Total timeout | 15 s (connect + body). Enforced via `AbortSignal`. |
| Redirects | 5 hops max, manual follow. The final URL is surfaced in the tool output. |
| Protocols | `http:` and `https:` only. |

The User-Agent is `factory/<version> (+https://github.com/vilaca/factory)`.

## Per-domain whitelist

WebFetch has a **separate** permission model from other tools. Standard tools are gated by name (`allowAll: ["Read", ...]`); WebFetch is gated by **hostname**, because a single allowlist of "WebFetch" would let the model fetch anything on the public internet.

When the model calls `WebFetch` for a hostname that hasn't been seen this session, the prompt offers four choices:

- **Allow once** — fetch this URL only.
- **Allow this domain** — fetch this URL and remember the hostname for the rest of the session.
- **Allow all** — equivalent to adding `WebFetch` to `permissions.allowAll`; bypasses future prompts regardless of hostname.
- **Deny** — return a tool-call denial to the model.

Domain decisions are session-scoped — they are **not** persisted to your config. To pre-seed the allowlist (so trusted domains skip the prompt), use `agent.web.allowlist`:

```json
{
  "agent": {
    "web": {
      "allowlist": ["docs.anthropic.com", "developer.mozilla.org"]
    }
  }
}
```

Hostname matching is case-insensitive and **exact** — no wildcard support yet, so `api.example.com` does not cover `v2.api.example.com`.

## Headless mode

In headless / non-TTY runs there's no UI to answer the per-domain prompt, so an unwhitelisted hostname falls through to the standard permission flow and the run exits with code 3 (permission denied) unless one of the following is true:

- The hostname is in `agent.web.allowlist`, **or**
- `WebFetch` is in `permissions.allowAll` (allows *every* hostname — use carefully).

For a CI job that needs WebFetch against a known set of hosts, prefer `agent.web.allowlist` over `permissions.allowAll`: the allowlist keeps the cap tight, where `allowAll` lets the model fetch anything.

See [headless.md](./headless.md) for the broader headless permission model.
