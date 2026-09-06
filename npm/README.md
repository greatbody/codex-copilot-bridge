# codex-copilot-bridge

Run the standalone Codex/Copilot bridge without installing Bun. Requires Node.js
22.14 or later. Prebuilt binaries support macOS arm64/x64 and Linux glibc
arm64/x64. Linux musl (including Alpine) and Windows are not supported.

```sh
npm install -g codex-copilot-bridge
codex-copilot-bridge --help
codex-copilot-bridge doctor
codex-copilot-bridge models --json
ghcodex --help
claudex --help
```

Without a global installation:

```sh
npx codex-copilot-bridge --help
npx codex-copilot-bridge serve
npx --package codex-copilot-bridge ghcodex --help
npx --package codex-copilot-bridge claudex --help
```

Running `codex-copilot-bridge` without arguments starts the bridge (`serve`).
The `ghcodex` and `claudex` launchers explicitly select their respective CLI
modes and pass remaining arguments through unchanged.

Platform binaries are delivered as version-matched optional npm dependencies;
do not disable optional dependencies. There is no postinstall downloader.
The scoped `@greatbody/codex-copilot-bridge-*` packages are binary payloads, not
standalone npm command packages.

Authentication and upstream client setup are separate from package installation.
See the [project documentation](https://github.com/greatbody/codex-copilot-bridge)
for prerequisites, configuration, and credential handling.
