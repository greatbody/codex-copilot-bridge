# Long-running Responses disconnect investigation

Date: 2026-09-15. Runtime: Bun 1.3.14.

## Root cause

`startServer` omitted `Bun.serve.idleTimeout`, inheriting the 10-second
default. A reasoning model's quiet interval can therefore terminate the
bridge's downstream HTTP stream while the upstream inference is still active.
It is not a three-minute session lifetime or an expired OAuth token.

The observed error chain was:

1. Codex sends Responses through Cloudflare, Sub2API, a TCP forwarder, and this bridge.
2. The bridge starts an HTTP 200 SSE response, then its HTTP server closes it prematurely.
3. Sub2API reports `stream read error: unexpected EOF` and emits its generic
   `Upstream request failed` streaming error.
4. Codex reports `stream disconnected before completion` and retries up to five times.
5. Retried requests can encounter the same idle limit.

Longer, more involved tasks increase the opportunity for silent reasoning
intervals. Raising the retry count does not address the cause.

## Evidence

- Correlated Codex and Sub2API logs by `x-client-request-id` for the exhausted
  retry sequence ending at 22:45:56 Asia/Shanghai. Sub2API's last two requests
  lasted 31,213 ms and 34,327 ms and both logged `unexpected EOF`; Codex received
  HTTP 200 before each streaming failure.
- The Sub2API application log contained 101 `openai.forward_failed` entries
  on that date at inspection time, all with that same EOF error. Its ops error
  database did not contain these streaming failures: application logs were needed.
- The bridge journal explicitly recorded:
  `[Bun.serve]: request timed out after 10 seconds. Pass idleTimeout to configure.`
  The process had no restarts during the observed failures.
- The deployed executable's SHA-256 was
  `9916a4cadf07fc95b30a59f87a8002e22d99cba31ea7535cea37937796656f56`.
  The existing local deployment record associated it with commit `01db0f1` and
  Bun 1.3.14. It reports version 0.1.0; its `src/server.ts` is identical to
  the pre-fix 0.2.0 checkout. A version upgrade alone would not fix this.
- A local HTTP reproduction using the real handler, default `Bun.serve`
  settings, and a delayed completion event failed after 12,039 ms with the same
  Bun idle-timeout warning. Timers are not exact wall-clock deadlines.
- A simultaneous same-host live A/B probe used the same credentials, model
  (`gpt-6-astra`, high reasoning), and synthetic combinatorics prompt:

  | Instance | Duration | Result |
  | --- | ---: | --- |
  | Deployed pre-fix bridge | 24.317 s | HTTP 200, early EOF, no terminal event |
  | Temporary patched bridge | 248.745 s | HTTP 200, `response.completed`, all 23 output items done |

  Model sampling is nondeterministic; the controlled local timeout reproduction
  supplies the causal check, and the live probe demonstrates practical recovery.

## Fix and verification

- Set `Bun.serve({ idleTimeout: 0 })` in the shared production startup path.
- Disable Bun's implicit outbound fetch timeout, as OpenCode does in
  `packages/opencode/src/provider/provider.ts`. The existing explicit discovery
  AbortSignal still bounds discovery. This closes a second timeout gap; the
  evidence above specifically identifies the inbound server timeout.
- Forward client cancellation to the Claude endpoint as well as native Responses.
- Exercise actual `startServer` in a credential-isolated child process with a
  fake upstream: 16 seconds of silence before headers, a 16-second gap inside SSE,
  and cancellation of both native and Claude requests. No hidden retries.
- `bun run check` passed; `bun test` passed all 134 tests (1,097 assertions).
- The Linux x64 standalone binary built successfully and ran the live probe.

## Deployment boundary

The patched executable ran only on a temporary loopback port on the existing
server. The temporary unit was stopped and its uploaded executable removed.
The existing production service remained active on its original executable.
No release, production replacement, or authenticated public-gateway
post-fix test was performed as part of this investigation.

To activate the correction, deploy a build containing this patch and restart
the bridge, then validate through the public gateway with a long inference.
Increasing only Codex's stream timeout or Sub2API's keepalive cannot prevent
the bridge's own HTTP server from closing the connection that Sub2API reads.
