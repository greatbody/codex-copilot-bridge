# codex-copilot-bridge

Local bridge that lets Codex CLI use GitHub Copilot models through the existing OpenCode Copilot login.

It reads `~/.local/share/opencode/auth.json` at runtime and uses the `github-copilot` OAuth entry. It does not print or copy the token.

## Prerequisites

- Bun installed locally.
- Codex CLI installed and available as `codex`.
- OpenCode has already logged in to GitHub Copilot, creating a `github-copilot` OAuth entry in `~/.local/share/opencode/auth.json`.

## Tested Environment

This project has been tested on macOS with Codex CLI v0.137.0.

Other operating systems, shells, and Codex versions have not been verified yet. PRs for compatibility fixes and validation reports are welcome.

## Security Notes

- Do not commit `~/.local/share/opencode/auth.json`, `.env`, logs, or built binaries.
- The bridge is intended for local use on `127.0.0.1`.
- Review GitHub Copilot terms and your plan limits before using this with automation.

## Install

### Homebrew

```bash
brew tap greatbody/tap
brew install codex-copilot-bridge
```

### From Source

```bash
bun install
bun run install:bin
```

This builds a standalone binary at `dist/codex-copilot-bridge` and links it to:

```text
/usr/local/bin/codex-copilot-bridge
```

## Run

```bash
codex-copilot-bridge
```

Default endpoint:

```text
http://127.0.0.1:18787/v1
```

## Response Compatibility

Codex should be configured with `wire_api="responses"`. For each `POST /v1/responses` request, the bridge checks live GitHub Copilot `/models` metadata and chooses the upstream endpoint for the requested model:

- Models that advertise native `/responses` support are passed through to Copilot's `/responses` endpoint. The existing request sanitization still removes `image_generation` tools before passthrough.
- Models that do not advertise `/responses` but do advertise `/v1/messages` are handled by the local Claude Messages adapter. This is Responses compatibility via translation, not native Claude Responses support.
- Models that advertise neither endpoint return a JSON error explaining the supported endpoints reported by Copilot.

The Claude adapter currently supports non-streaming responses and streaming text/tool-call events. It maps common Codex Responses fields into Anthropic Messages:

- `model`
- `instructions` and string `system` text
- string input and message arrays
- `input_text` and representable `input_image` parts
- function tools and common `tool_choice` forms
- Responses `function_call_output` items to Claude `tool_result` blocks
- Claude `tool_use` blocks back to Responses `function_call` output items
- `max_output_tokens` to `max_tokens`
- available usage fields

Known limitations for the Claude adapter:

- OpenAI hosted tools such as image generation, web search, file search, computer use, and code interpreter are rejected with JSON errors.
- `previous_response_id` persistence is not implemented; send the full conversation context instead.
- Exact OpenAI Responses streaming event parity is not guaranteed.
- Encrypted reasoning content and provider-native reasoning controls are dropped because they are not representable in Anthropic Messages.
- Provider-specific fields without an Anthropic Messages equivalent may be ignored.

## Codex Config Example

The easiest way is to use an installed wrapper. Both wrappers start the bridge if needed and forward all remaining arguments to `codex`.

```bash
ghcodex "Reply exactly: ok"
claudex "Reply exactly: ok"
```

`ghcodex` is for native Copilot `/responses` models such as GPT. It does not force a model and does not disable hosted web search, so GPT models keep normal Codex capabilities.

`claudex` is for Copilot models served through the Claude `/v1/messages` adapter. It does not force a model, but it limits the `/model` picker to adapter-backed models and passes `web_search="disabled"` because Claude Messages cannot represent OpenAI's hosted `web_search` tool.

Both wrappers keep the same argument shape as `codex`; they prepend the Copilot bridge provider config and forward all arguments unchanged. The interactive `/model` picker can switch among the model family exposed by the wrapper you launched.

The wrappers also select separate Codex config profiles by default: `ghcodex` uses `~/.codex/copilot.config.toml`, and `claudex` uses `~/.codex/claudex.config.toml`. This keeps `/model` selections isolated from the global `~/.codex/config.toml` and from each other. Pass your own `--profile <name>` if you want to override this behavior.

The bridge builds its Codex model list from Copilot's live `/models` response. If `~/.codex/models_cache.json` contains a template for a live model, the bridge reuses that template and overwrites availability, endpoint, context-window, and token-limit fields from Copilot. Live Copilot models that are not in Codex's cache are exposed dynamically when the bridge can serve them through native `/responses` passthrough or the local Messages adapter.

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

## Release

Releases are built by GitHub Actions when a `v*` tag is pushed. The workflow builds the macOS x64 tarball, creates the GitHub Release, and updates the `greatbody/homebrew-tap` formula.

The repository needs a `GH_TOKEN_FOR_TAP` secret with write access to `greatbody/homebrew-tap`.

```bash
git tag v0.1.1
git push origin v0.1.1
```
