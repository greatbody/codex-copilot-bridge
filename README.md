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

## Codex Config Example

The easiest way is to use the installed wrapper. It starts the bridge if needed and forwards all arguments to `codex`:

```bash
ghcodex "Reply exactly: ok"
```

`ghcodex` keeps the same argument shape as `codex`; it prepends the Copilot bridge provider config and forwards all arguments unchanged. It starts `codex-copilot-bridge` automatically if port `18787` is not already serving.

The bridge uses `~/.codex/models_cache.json` as the model schema template for models Codex already knows, which avoids noisy model-refresh decode errors while still checking current Copilot model availability. Context-window and token-limit fields are overwritten from Copilot's live `/models` response.

Manual equivalent:

```bash
OPENAI_API_KEY=dummy codex exec --skip-git-repo-check \
  -c model_provider='"copilot_bridge"' \
  -c model='"gpt-5.4-mini"' \
  -c 'model_providers.copilot_bridge={name="Copilot Bridge",base_url="http://127.0.0.1:18787/v1",env_key="OPENAI_API_KEY",wire_api="responses"}' \
  "Reply exactly: ok"
```
