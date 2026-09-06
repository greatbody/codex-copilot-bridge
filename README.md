# codex-copilot-bridge

Local bridge that lets Codex CLI use GitHub Copilot models through the existing OpenCode Copilot login.

It reads `~/.local/share/opencode/auth.json` at runtime and uses the `github-copilot` OAuth entry. It does not print or copy the token.

## Prerequisites

- Codex CLI installed and available as `codex`.
- OpenCode has already logged in to GitHub Copilot, creating a `github-copilot` OAuth entry in `~/.local/share/opencode/auth.json`.
- Standalone binaries and Homebrew installations do not require Bun or Node.js to run the bridge. Codex has its own installation requirements.
- The npm launcher requires Node.js >=22.14.0, but does not require Bun.
- Source builds and development require Bun 1.3.14, pinned in `.bun-version`.

## Availability and Validation

The unified CLI, multi-platform release workflow, and npm packaging are implemented in this checkout. This does **not** mean the new multi-platform archives or npm packages have already been published. Users can continue using the existing Homebrew release; its version and available platforms may lag this checkout. The npm commands below become available only after a maintainer publishes the packages.

Previous live compatibility testing used macOS with Codex CLI v0.137.0. This checkout's new CLI and packaging have been verified locally on macOS x64 using mock Codex and Copilot endpoints, not a fresh live inference session. The configured CI/release matrix will verify the other hosts; matrix membership is not evidence of a completed successful run.

| Target | Native CI Runner | Validation Status |
| --- | --- | --- |
| `darwin-x64` | `macos-15-intel` | Locally verified; CI also configured |
| `darwin-arm64` | `macos-15` | CI verification pending |
| `linux-x64` (glibc) | `ubuntu-24.04` | CI verification pending |
| `linux-arm64` (glibc) | `ubuntu-24.04-arm` | CI verification pending |

Windows and Linux musl (including Alpine) are not supported. No Docker image or Docker-based installation workflow is provided. Other Codex versions and shells remain unverified; compatibility reports are welcome.

## Security Notes

- Do not commit `~/.local/share/opencode/auth.json`, `.env`, logs, or built binaries.
- The bridge is intended for local use on `127.0.0.1`.
- Review GitHub Copilot terms and your plan limits before using this with automation.

## Install

### Homebrew

The existing published release is available through the tap:

```bash
brew tap greatbody/tap
brew install codex-copilot-bridge
```

The CLI behavior documented below describes this checkout, not a guarantee that an older Homebrew release already includes it.

### npm (After Publication)

Once the maintainer has published the launcher and platform packages:

```bash
npm install --global --include=optional codex-copilot-bridge
codex-copilot-bridge --help
ghcodex "Reply exactly: ok"
claudex "Reply exactly: ok"
```

Without a global installation, after publication:

```bash
npx codex-copilot-bridge --help
npx codex-copilot-bridge serve
npx --package codex-copilot-bridge ghcodex --help
npx --package codex-copilot-bridge claudex --help
```

The public `codex-copilot-bridge` package is a Node.js launcher with exact-version optional dependencies on `@greatbody/codex-copilot-bridge-{platform}` for the four targets above. Those scoped packages contain standalone binaries, not separate npm commands. Keep optional dependencies enabled: there is no `postinstall` script, runtime downloader, or local compilation fallback. Bun is embedded in the binary, not an end-user prerequisite.

### From Source

From the repository root, with Bun 1.3.14 installed:

```bash
bun install --frozen-lockfile
bun run install:bin
```

`install:bin` typechecks, builds the unified CLI at `dist/codex-copilot-bridge`, and uses `scripts/install.ts` to symlink all three commands to that binary. `PREFIX` defaults to `/usr/local`:

```text
/usr/local/bin/codex-copilot-bridge
/usr/local/bin/ghcodex
/usr/local/bin/claudex
```

Choose a writable prefix if needed, and add its `bin` directory to `PATH`:

```bash
PREFIX="$HOME/.local" bun run install:bin
export PATH="$HOME/.local/bin:$PATH"
```

Keep the checkout and built binary in place while using these symlinks. The installer refuses to replace an existing regular file or directory; resolve conflicts with another installation explicitly.

## CLI

| Command | Behavior |
| --- | --- |
| `codex-copilot-bridge --help` | Show bridge help without reading credentials |
| `codex-copilot-bridge --version` | Show the bridge version without reading credentials |
| `codex-copilot-bridge serve` | Run the foreground loopback API; also the default with no arguments |
| `codex-copilot-bridge doctor` | Check Codex in `PATH`, credentials, and live Copilot model discovery |
| `codex-copilot-bridge models` | Print model IDs and context/input/output limits |
| `codex-copilot-bridge models --json` | Print model metadata as JSON |
| `codex-copilot-bridge ghcodex [args...]` | Run Codex with native Responses models |
| `codex-copilot-bridge claudex [args...]` | Run Codex with the Claude Messages adapter |

Installed aliases `ghcodex` and `claudex` select the corresponding wrapper mode. **`ghcodex --version` and `claudex --version` report Codex's version, not the bridge's.** Wrapper help/version and recognized non-provider commands bypass bridge startup and forward to Codex.

`doctor` and `models` use temporary local servers and live credentials; they are not offline smoke checks. `doctor` reports credential presence, never the token. `/health` on a running server checks local service health only, not upstream connectivity.

### Manual Server

```bash
codex-copilot-bridge serve
# Equivalent: codex-copilot-bridge
```

The default endpoint is `http://127.0.0.1:18787/v1`. Override the manual server port with `PORT`:

```bash
PORT=18788 codex-copilot-bridge serve
```

`serve` remains in the foreground until stopped. It is independent of wrapper-owned servers: wrappers neither reuse nor stop it. Each inference wrapper invocation binds its own ephemeral port on `127.0.0.1`, regardless of `PORT`.

| Environment Variable | Purpose |
| --- | --- |
| `PORT` | Manual `serve` port, default `18787`; valid integers are `0` through `65535` (`0` requests an ephemeral port) |
| `OPENCODE_AUTH_FILE` | Override the default OpenCode auth file path |
| `CODEX_HOME` | Codex home and shared model cache location, default `~/.codex` |
| `PREFIX` | Source installation prefix, default `/usr/local` |

## Response Compatibility

Codex should be configured with `wire_api="responses"`. For each `POST /v1/responses` request, the bridge checks live GitHub Copilot `/models` metadata and chooses the upstream endpoint for the requested model:

- Models that advertise native `/responses` support are forwarded to Copilot's `/responses` endpoint. Successful SSE responses have their protocol identities normalized as described below. The existing request sanitization still removes `image_generation` tools before forwarding.
- Models that do not advertise `/responses` but do advertise `/v1/messages` are handled by the local Claude Messages adapter. This is Responses compatibility via translation, not native Claude Responses support.
- Models that advertise neither endpoint return a JSON error explaining the supported endpoints reported by Copilot.

For `gpt-5.6-sol`, Codex `service_tier="fast"`, `"priority"`, and `"ultrafast"` requests are routed to Copilot's `gpt-5.6-sol-fast` model ID with the unsupported `service_tier` field removed. Copilot serves this route as Fast/Priority processing; the bridge does not claim native Ultrafast service from Copilot.

### Native SSE Identities

Copilot can return different opaque IDs for the same response or output item across start, delta, done, and final-snapshot events. Clients that upsert messages by ID can then display one message twice. `src/responses-stream.ts` retains the first response ID and the first item ID for each `output_index`, including reasoning and tools in final output-array positions. It never deduplicates text: separate messages containing identical text remain separate.

This follows [OpenCode's Copilot compatibility approach](https://github.com/anomalyco/opencode/blob/bbd72fb8b0bb6de580d2041a0150016227c63ac0/packages/core/src/github-copilot/responses/openai-responses-language-model.ts), but keeps Responses SSE rather than emitting AI SDK events. Completion events and their full output payloads remain present. Only known protocol `response.id`, `response_id`, `item.id`, and `item_id` slots change; `call_id`, arguments, encrypted reasoning, annotations, phase, usage, and arbitrary metadata are not recursively rewritten.

Missing start events are supported when an output index is available. Without an index, a previously observed ID can identify the item; a new rotating ID is accepted only when its type has exactly one observed, still-open item. Missing-index starts, conflicting references, and ambiguous events fail the stream rather than guessing or merging items. No replacement IDs are generated, and all identity state is scoped to one request.

The parser incrementally handles UTF-8, LF/CRLF/CR framing and multiline data, retaining SSE fields, comments, unknown events, and `[DONE]`. Malformed/non-JSON data frames pass through unchanged. Invalid UTF-8, ambiguous identities, or resource limits produce a stream error and cancel the upstream reader. Limits are 16 Mi UTF-16 code units per frame, 4096 output items, and 65536 observed item-ID aliases per stream. Unknown future event types are deliberately not normalized. Non-streaming JSON, HTTP error bodies and the Anthropic adapter are unchanged. Transformed bodies do not retain stale length, encoding, entity-tag, digest or range headers.

Regression coverage in `test/responses-stream*.test.ts` includes an actual HTTP bridge, identical-text messages, reasoning/tool snapshots, tool-result continuation, interleaved requests, framing, backpressure, cancellation and errors. Before the fix, the ID-keyed consumer fixture produced four entries for two messages on both GPT-6 and GPT-5.5 fixtures; after normalization it produces exactly two, without changing their content. These fixtures are synthetic, not packet captures.

Direct stream cancellation/error tests verify upstream cancellation and reader release. HTTP disconnect tests use an explicit client request abort: Bun's HTTP fetch reader cancellation alone did not reliably close the connection during testing. This patch forwards the incoming request's abort signal upstream; it does not claim to change that client-runtime behavior.

Local live verification on 2026-09-06 used an ephemeral patched bridge and GPT-6 Astra: a small text stream and a forced synthetic function call followed by its result all returned HTTP 200 with stable response/item identities and the expected text. The follow-up reused the normalized final output objects and original first-seen opaque IDs without alteration, preserving `call_id`. This validates that stateless tool round trip, not arbitrary opaque-ID reuse, encrypted-reasoning continuation (no reasoning item was returned), or `previous_response_id` persistence. The desktop UI and deployed service have not been verified or changed by this repository fix.

The Claude adapter currently supports non-streaming responses and streaming text/tool-call events. It maps common Codex Responses fields into Anthropic Messages:

- `model`
- `instructions` and string `system` text
- string input and message arrays
- `input_text` and representable `input_image` parts
- function tools and common `tool_choice` forms
- Responses `function_call_output` items to Claude `tool_result` blocks
- Claude `tool_use` blocks back to Responses `function_call` output items
- `max_output_tokens` to `max_tokens`
- `reasoning.effort` to advertised adaptive thinking (`thinking.type="adaptive"` and `output_config.effort`), or `high`/`max` thinking budgets for budget-based models
- usage fields, including cache reads and cache creation in the input-token total

The Claude adapter derives selectable reasoning levels from Copilot metadata. Unsupported efforts return HTTP 400 instead of being silently dropped. Thinking budgets stay below `max_tokens` and respect the advertised minimum and output limit. When omitted, `max_tokens` defaults to the advertised output limit (4096 if unavailable). Forced tool choices cannot be combined with thinking; use `auto`.

Original signed thinking and redacted-thinking blocks accompanying tool calls are retained in memory and restored on follow-up requests, for both streaming and non-streaming responses. The cache is scoped by model and tool-call ID, expires after one hour, and holds at most 4096 tool calls. Restarting the bridge clears it. Raw thinking and signatures are not exposed as Responses output.

Known limitations for the Claude adapter:

- `image_generation` tools are filtered out; hosted web search, file search, computer use, and code interpreter are rejected with JSON errors.
- `previous_response_id` persistence is not implemented; send the full conversation context instead.
- Exact OpenAI Responses streaming event parity is not guaranteed.
- OpenAI encrypted reasoning cannot be translated into Claude thinking; only the bridge's original cached Claude blocks are replayed.
- Provider-specific fields without an Anthropic Messages equivalent may be ignored.

## Codex Config Example

The easiest way is to use an installed wrapper. For each inference invocation, the wrapper owns an ephemeral loopback server, starts Codex with that server's URL, and stops the server when Codex exits. It forwards termination signals and propagates Codex's exit status. It does not launch a detached daemon.

```bash
ghcodex "Reply exactly: ok"
claudex "Reply exactly: ok"
```

`ghcodex` is for native Copilot `/responses` models such as GPT. It does not force a model and does not disable hosted web search, so GPT models keep normal Codex capabilities.

`claudex` is for Copilot models served through the Claude `/v1/messages` adapter. It does not force a model, but it limits the `/model` picker to adapter-backed models and passes `web_search="disabled"` because Claude Messages cannot represent OpenAI's hosted `web_search` tool.

Both wrappers keep the same argument shape as `codex`; they prepend the Copilot bridge provider config and forward all arguments unchanged. The interactive `/model` picker can switch among the model family exposed by the wrapper you launched.

The wrappers select separate Codex config profiles by default: `ghcodex` passes `--profile copilot`, and `claudex` passes `--profile claudex`. Configure those profiles using your installed Codex version's profile mechanism, or pass your own `--profile <name>`. The bridge does not create profile configuration files. Server subcommands such as `app-server` and `mcp-server` receive provider overrides without a default profile.

Profile selection is unchanged, but this is **not full cache isolation**. Both wrappers still read and atomically replace the shared `$CODEX_HOME/models_cache.json` (default `~/.codex/models_cache.json`) with their selected model family. Concurrent wrapper sessions can overwrite each other's model list. Existing cache metadata is preserved rather than migrated.

The bridge builds its Codex model list from Copilot's live `/models` response. If `~/.codex/models_cache.json` contains a template for a live model, the bridge reuses that template and overwrites availability, endpoint, context-window, and token-limit fields from Copilot. Live Copilot models that are not in Codex's cache are exposed dynamically when the bridge can serve them through native `/responses` passthrough or the local Messages adapter.

Model discovery has a five-second timeout, coalesces concurrent requests, and caches results for 30 seconds. Transient refresh failures keep the last successful list and retry after five seconds; the first discovery must succeed. `CODEX_HOME` is respected when reading the model cache.

Total context, maximum input, and maximum output remain separate. Missing total context falls back to the upstream input limit, never an unrelated cached model's window. The bridge sets `auto_compact_token_limit` to the input limit minus up to 20,000 output/headroom tokens; without an input limit it reserves the output limit from total context. Codex may compact earlier according to its own context percentage. Missing capabilities are explicitly cleared when templates are merged, and models without advertised vision support are text-only.

For the manual examples below, first run `codex-copilot-bridge serve` in another terminal. Adjust the base URL if you changed `PORT`.

Manual GPT/native equivalent:

```bash
OPENAI_API_KEY=dummy codex exec --skip-git-repo-check \
  -c model_provider='"copilot_bridge"' \
  -c 'model_providers.copilot_bridge={name="Copilot Bridge",base_url="http://127.0.0.1:18787/v1",env_key="OPENAI_API_KEY",wire_api="responses"}' \
  "Reply exactly: ok"
```

Manual Claude-adapter equivalent:

```bash
OPENAI_API_KEY=dummy codex exec --skip-git-repo-check \
  -c web_search='"disabled"' \
  -c model_provider='"copilot_bridge"' \
  -c model='"claude-sonnet-4.6"' \
  -c 'model_providers.copilot_bridge={name="Copilot Bridge",base_url="http://127.0.0.1:18787/v1",env_key="OPENAI_API_KEY",wire_api="responses"}' \
  "Reply exactly: ok"
```

### Lifecycle Upgrade Warning

The move from the old shared fixed-port background server to per-invocation servers is a **breaking lifecycle change**. Scripts must not assume that running `ghcodex` or `claudex` leaves an API listening on port `18787`. Use an explicitly managed `serve` process for independent API clients. Old background processes are not automatically stopped by the new wrappers; stop them separately if no longer needed.

Wrapper shutdown also clears that server's in-memory Claude thinking cache. Signed thinking blocks are retained within a running session, not across wrapper invocations. Separate model-selection profiles remain in use; the shared disk model-cache caveat above still applies.

## Development and Validation

Use the Bun version in `.bun-version` (currently `1.3.14`) and the committed lockfile. Node.js and npm/npx are also needed for packaging tests and smoke checks; CI pins Node.js `24.20.0`. Workflows pin actions to commit SHAs, and npm publishing pins npm `12.0.2`.

From the repository root, this example uses the locally verified **macOS x64** host:

```bash
bun install --frozen-lockfile
bun run check
bun run test
bun run package:release darwin-x64
bun run smoke darwin-x64
```

Use the actual host target from the matrix on other machines. Smoke testing rejects a target that does not match the host. `package:release` builds `dist/<platform>/codex-copilot-bridge` and `dist/codex-copilot-bridge-v<version>-<platform>.tar.gz`; x64 builds use Bun's baseline targets. Each archive contains the binary, relative `ghcodex`/`claudex` symlinks, README, and license.

`smoke` consumes those existing artifacts without recompiling. It checks standalone help/version without credentials or runtimes in `PATH`, alias forwarding and exit codes with mock Codex, and offline local npm tarball installation through npm exec, npx, and an isolated global prefix. These checks do not publish packages or prove live Copilot compatibility on another host.

To inspect generated npm packages from the existing host binary:

```bash
bun run package:npm darwin-x64
```

This writes the public launcher to `dist/npm/codex-copilot-bridge` and the selected binary package to `dist/npm/darwin-x64`. The launcher still declares exact-version optional dependencies for all four platforms. With all four release binaries present, `bun run package:npm` generates the complete five-package distribution without recompiling.

The repository root `package.json` is deliberately `private: true`. **Never run `npm publish` at the repository root or remove `private` to publish it.** Only the generated `dist/npm/*` packages are publication inputs.

`.github/workflows/ci.yml` runs typechecks, tests, native packaging, and credential-free smoke checks for each matrix host on pull requests and pushes to `main`. The weekly/manual maintenance workflow audits locked dependencies without live credentials. Dependabot proposes weekly Bun dependency and GitHub Actions updates.

## Release

The implemented workflow in `.github/workflows/release.yml` runs only on pushed `v*` tags. It validates that the tagged commit's `package.json` has a stable `major.minor.patch` version and that the tag is exactly `v<version>`; prerelease tags and version mismatches fail.

### Maintainer Setup

GitHub Release creation is part of the tag workflow. npm publication and Homebrew updates are independent opt-ins, disabled unless their repository variable is the literal string `true`:

| Setting | Requirement |
| --- | --- |
| Repository variable `PUBLISH_NPM=true` | Enable npm publication after GitHub Release creation and npm onboarding |
| Repository variable `UPDATE_HOMEBREW=true` | Enable the tap update after GitHub Release creation |
| Secret `GH_TOKEN_FOR_TAP` | Token with `Contents: write` on `greatbody/homebrew-tap`, required for the enabled tap job |

Before enabling npm publication, establish account/namespace ownership and trusted-publisher configuration for **all five packages**:

- `codex-copilot-bridge`
- `@greatbody/codex-copilot-bridge-darwin-arm64`
- `@greatbody/codex-copilot-bridge-darwin-x64`
- `@greatbody/codex-copilot-bridge-linux-x64`
- `@greatbody/codex-copilot-bridge-linux-arm64`

Configure each npm trusted publisher for GitHub repository `greatbody/codex-copilot-bridge` and workflow filename `release.yml`, and explicitly allow direct `npm publish` rather than staging-only access. First-time package creation may require manual account/namespace onboarding or an authorized bootstrap publication before trusted publishing can be configured. OIDC does not automatically authorize a namespace or guarantee creation of new packages. The workflow assumes onboarding is already complete and uses GitHub OIDC with provenance, not a stored npm token.

### Release Sequence

1. Choose a new, unused stable version, update `package.json`, review the lifecycle change above, and commit the release changes. Do not reuse an existing release tag or npm version.
2. Complete local checks and review the native CI results. Tag that exact commit with `v<package.json version>` and push the tag when ready to publish.
3. The workflow validates the version and runs tests on all four native hosts. It builds each release binary once, smoke-tests its archive and local npm package, and attests the binary and archive.
4. After every build succeeds, it creates the GitHub Release with four archives and `SHA256SUMS`. It fails if the release already exists rather than overwriting assets.
5. If enabled, the npm job consumes the tested binaries without rebuilding and publishes the four platform packages before the public launcher. Existing npm versions fail rather than being silently skipped on retry.
6. If enabled, the Homebrew job generates the four-platform formula from the published `SHA256SUMS` and commits only the formula to the tap. It does not rebuild binaries.

If a downstream publication job fails, the GitHub Release may already exist. Inspect the published state before retrying; the workflow is not a transactional rollback or an overwrite mechanism.

### Verify Downloads

After a release from this workflow has actually been published, select its tag (not an assumed future version) and download the archives and checksums into an empty working directory:

```bash
TAG=vX.Y.Z # Replace with an existing published stable tag
gh release download "$TAG" --repo greatbody/codex-copilot-bridge \
  --pattern '*.tar.gz' --pattern SHA256SUMS
shasum -a 256 --check SHA256SUMS
# Linux alternative: sha256sum --check SHA256SUMS

# Example for macOS x64; choose the archive for your actual host.
gh attestation verify "codex-copilot-bridge-${TAG}-darwin-x64.tar.gz" \
  --repo greatbody/codex-copilot-bridge
```

Checksums detect changed archive bytes; `gh attestation verify` verifies build provenance against the repository. Older releases may not contain checksums or attestations from this new workflow.
