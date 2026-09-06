const { spawn } = require("node:child_process")
const { constants } = require("node:os")

function selectPlatform(os, arch, glibcVersion) {
  if (!["darwin", "linux"].includes(os) || !["arm64", "x64"].includes(arch)) {
    throw new Error(`Unsupported platform: ${os}-${arch}. Supported: macOS and Linux (glibc), arm64 and x64.`)
  }
  if (os === "linux" && !glibcVersion) {
    throw new Error("Linux requires glibc; musl/Alpine is not supported by the prebuilt binaries.")
  }
  return `${os}-${arch}`
}

function run(mode) {
  let binary
  try {
    const platform = selectPlatform(process.platform, process.arch,
      process.platform === "linux" ? process.report.getReport().header.glibcVersionRuntime : undefined)
    const name = `@greatbody/codex-copilot-bridge-${platform}`
    try {
      binary = require.resolve(`${name}/bin/codex-copilot-bridge`)
    } catch {
      throw new Error(`Missing platform binary (${name}). Reinstall codex-copilot-bridge with optional dependencies enabled (npm install --include=optional codex-copilot-bridge).`)
    }
  } catch (error) {
    console.error(`codex-copilot-bridge: ${error.message}`)
    process.exitCode = 1
    return
  }

  const child = spawn(binary, [...(mode ? [mode] : []), ...process.argv.slice(2)], { stdio: "inherit" })
  const handlers = new Map(["SIGINT", "SIGTERM", "SIGHUP"].map(signal => [signal, () => child.kill(signal)]))
  for (const [signal, handler] of handlers) process.on(signal, handler)
  const cleanup = () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler)
  }
  child.on("error", error => {
    cleanup()
    console.error(`codex-copilot-bridge: Cannot start ${binary}: ${error.message}`)
    process.exitCode = 1
  })
  child.on("exit", (code, signal) => {
    cleanup()
    if (signal) {
      process.exitCode = 128 + constants.signals[signal]
      process.kill(process.pid, signal)
    } else {
      process.exitCode = code ?? 1
    }
  })
}

module.exports = { run, selectPlatform }
