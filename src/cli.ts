import path from "node:path"
import { mkdir, rename, rm } from "node:fs/promises"
import { spawn } from "node:child_process"
import { constants } from "node:os"
import { version } from "../package.json"
import { startServer, readCopilotAuth } from "./server"
import { endpointIsSupported, type CodexModelTemplate } from "./copilot"

const help = `Usage: codex-copilot-bridge [command]

Commands:
  serve              Run the loopback API (default; PORT defaults to 18787)
  models [--json]     List models and limits using your Copilot login
  doctor             Check credentials, Codex, and live model discovery
  ghcodex [args...]   Run Codex with native Responses models
  claudex [args...]   Run Codex with the Claude Messages adapter
  --help             Show this help without accessing credentials
  --version          Show the bridge version

Wrappers own an ephemeral loopback server and stop it when Codex exits.
Requires an existing OpenCode Copilot login. No credentials are printed.
`

export function codexArguments(mode: "ghcodex" | "claudex", args: string[], baseURL: string) {
  const noProfile = ["login", "logout", "plugin", "mcp-server", "app-server", "remote-control", "app", "completion", "update", "doctor", "execpolicy", "apply", "a", "cloud", "cloud-tasks", "responses-api-proxy", "stdio-to-uds", "exec-server", "features"].includes(args[0])
    || (args[0] === "debug" && args[1] !== "prompt-input")
  if (["--help", "-h", "--version", "-V", "login", "logout", "completion", "update", "doctor"].includes(args[0])) return { needsBridge: false, args }
  const profile = noProfile || args.some(arg => arg === "--profile" || arg.startsWith("--profile=") || arg === "-p" || (arg.startsWith("-p") && arg.length > 2))
    ? [] : ["--profile", mode === "claudex" ? "claudex" : "copilot"]
  return { needsBridge: true, args: [
    ...profile,
    "-c", 'model_provider="copilot_bridge"',
    "-c", `model_providers.copilot_bridge={name="Copilot Bridge",base_url=${JSON.stringify(baseURL)},env_key="OPENAI_API_KEY",wire_api="responses"}`,
    ...(mode === "claudex" ? ["-c", 'web_search="disabled"'] : []), ...args,
  ] }
}

export function mergeModelCache(cache: { models?: CodexModelTemplate[] }, models: CodexModelTemplate[], mode: "ghcodex" | "claudex") {
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) cache = {}
  if (!Array.isArray(cache.models)) cache = { ...cache, models: [] }
  const existing = new Map((cache.models ?? []).map(model => [model.slug ?? model.id, model]))
  const fallback = cache.models?.[0]
  const selected = models.filter(model => {
    const metadata = { supported_endpoints: model.supported_endpoints as string[] | undefined }
    const responses = endpointIsSupported(metadata, "/responses")
    return mode === "ghcodex" ? responses : !responses && endpointIsSupported(metadata, "/v1/messages")
  })
  return { ...cache, fetched_at: new Date().toISOString(), models: selected.map(model => {
    const old = existing.get(model.slug ?? model.id)
    return { ...fallback, ...old, ...model,
      supports_search_tool: mode === "claudex" ? false : old?.supports_search_tool ?? fallback?.supports_search_tool ?? true,
      web_search_tool_type: mode === "claudex" ? undefined : old?.web_search_tool_type ?? fallback?.web_search_tool_type ?? "text_and_image",
    }
  }) }
}

async function getModels(origin: string) {
  const response = await fetch(`${origin}/v1/models`, { signal: AbortSignal.timeout(8000) })
  if (!response.ok) throw new Error(`Model discovery failed (HTTP ${response.status}); check Copilot login and connectivity`)
  const body = await response.json() as { models?: CodexModelTemplate[] }
  if (!Array.isArray(body.models)) throw new Error("Invalid bridge model list")
  return body.models
}

async function runCodex(mode: "ghcodex" | "claudex", args: string[]) {
  const codex = Bun.which("codex")
  if (!codex) throw new Error("codex not found in PATH. Install Codex CLI first.")
  let invocation = codexArguments(mode, args, "")
  // A per-session server avoids stale daemons and shutdown races between wrappers.
  const server = invocation.needsBridge ? await startServer(0) : undefined
  try {
    if (server) {
      invocation = codexArguments(mode, args, `${server.url.origin}/v1`)
      const cachePath = path.join(process.env.CODEX_HOME ?? path.join(process.env.HOME ?? "", ".codex"), "models_cache.json")
      const cache = await Bun.file(cachePath).json().catch(() => ({}))
      const updated = mergeModelCache(cache, await getModels(server.url.origin), mode)
      if (!updated.models.length) throw new Error(`No compatible models are available for ${mode}`)
      const temporary = `${cachePath}.${process.pid}.tmp`
      try {
        await mkdir(path.dirname(cachePath), { recursive: true })
        await Bun.write(temporary, `${JSON.stringify(updated, null, 2)}\n`)
        await rename(temporary, cachePath)
      } finally {
        await rm(temporary, { force: true })
      }
    }
    const child = spawn(codex, invocation.args, { stdio: "inherit", env: { ...process.env, OPENAI_API_KEY: process.env.OPENAI_API_KEY || "dummy" } })
    const handlers = new Map((["SIGINT", "SIGTERM", "SIGHUP"] as const).map(signal => [signal, () => child.kill(signal)]))
    for (const [signal, handler] of handlers) process.on(signal, handler)
    try {
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject)
        child.once("exit", (code, signal) => resolve({ code, signal }))
      })
      if (result.signal) return 128 + constants.signals[result.signal]
      return result.code ?? 1
    } finally {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler)
    }
  } finally {
    server?.stop(true)
  }
}

export async function main(args: string[], executable = process.argv0) {
  const alias = path.basename(executable)
  if (alias === "ghcodex" || alias === "claudex") return runCodex(alias, args)
  const command = args[0] ?? "serve"
  if (["--help", "-h"].includes(command)) { console.log(help); return 0 }
  if (["--version", "-V"].includes(command)) { console.log(`codex-copilot-bridge ${version}`); return 0 }
  if (command === "ghcodex" || command === "claudex") return runCodex(command, args.slice(1))
  if (!["serve", "doctor", "models"].includes(command) || (args.length > 1 && !(command === "models" && args.length === 2 && args[1] === "--json"))) {
    throw new Error("Unknown command or argument. Run codex-copilot-bridge --help")
  }
  if (command === "serve") {
    const server = await startServer()
    console.error(`codex-copilot-bridge ${version} listening on ${server.url.origin}/v1`)
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => { server.stop(true); process.exit(0) })
    return 0
  }
  if (command === "doctor") {
    console.log(`Bridge: ${version} (${process.platform}-${process.arch})`)
    console.log(`Codex: ${Bun.which("codex") ? "found" : "NOT FOUND in PATH"}`)
    await readCopilotAuth()
    console.log("Copilot credentials: present (not displayed)")
  }
  const server = await startServer(0)
  try {
    const models = await getModels(server.url.origin)
    if (command === "doctor") {
      console.log(`Copilot discovery: OK (${models.length} compatible models)`)
      return Bun.which("codex") ? 0 : 1
    }
    if (args[1] === "--json") console.log(JSON.stringify({ object: "list", data: models, models }, null, 2))
    else {
      console.log("MODEL\tCONTEXT\tMAX INPUT\tMAX OUTPUT")
      for (const model of models) console.log([model.id, model.context_window ?? "unknown", model.max_prompt_tokens ?? "unknown", model.max_output_tokens ?? "unknown"].join("\t"))
    }
    return 0
  } finally { server.stop(true) }
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).then(code => { process.exitCode = code }).catch(error => {
    console.error(`codex-copilot-bridge: ${error instanceof Error ? error.message : "Unexpected error"}`)
    process.exitCode = 1
  })
}
