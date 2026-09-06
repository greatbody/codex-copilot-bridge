import { afterEach, expect, mock, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { createInterface } from "node:readline"
import { version } from "../package.json"
import { codexArguments, mergeModelCache } from "../src/cli"
import { createHandler } from "../src/server"
import type { CodexModelTemplate } from "../src/copilot"

const root = path.resolve(import.meta.dir, "..")
const temporary: string[] = []
const modes = ["ghcodex", "claudex"] as const

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  await mkdir(path.join(root, "dist"), { recursive: true })
  const directory = await mkdtemp(path.join(root, "dist", ".cli-test-"))
  temporary.push(directory)
  const bin = path.join(directory, "bin")
  const home = path.join(directory, "home")
  await mkdir(bin)
  await mkdir(home)
  const env = {
    HOME: home, CODEX_HOME: path.join(home, "codex"),
    OPENCODE_AUTH_FILE: path.join(home, "auth.json"), PATH: bin,
    XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"),
  }
  return {
    directory, bin, env,
    run(args: string[], overrides = {}) {
      const result = spawnSync(process.execPath, [path.join(root, "src", "cli.ts"), ...args], {
        cwd: directory, env: { ...env, ...overrides }, encoding: "utf8", timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      })
      expect(result.error).toBeUndefined()
      expect(result.signal).toBeNull()
      return result
    },
  }
}

async function inferenceFixture() {
  const context = await fixture()
  const { directory, bin, env } = context
  const node = Bun.which("node")
  expect(node).not.toBeNull()
  await symlink(node!, path.join(bin, "node"))
  await writeFile(env.OPENCODE_AUTH_FILE, JSON.stringify({ "github-copilot": { type: "oauth", refresh: "offline-test-token" } }))
  const preload = path.join(directory, "upstream.ts")
  await writeFile(preload, `
import assert from "node:assert/strict"
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input)
  if (url.origin !== "https://api.githubcopilot.com") {
    assert.equal(url.origin.startsWith("http://127.0.0.1:"), true, "unexpected external request")
    return realFetch(input, init)
  }
  const request = new Request(input, init)
  assert.equal(request.headers.get("authorization"), "Bearer offline-test-token")
  if (url.pathname === "/models") {
    assert.equal(request.method, "GET")
    return Response.json({ data: [
      { id: "offline-model", supported_endpoints: ["/responses"], capabilities: { limits: { max_context_window_tokens: 123456 } } },
      { id: "messages-only", supported_endpoints: ["/v1/messages"] },
    ] })
  }
  assert.equal(url.pathname, "/responses")
  assert.equal(request.method, "POST")
  assert.deepEqual(await request.json(), { model: "offline-model", input: "offline prompt", stream: false })
  return Response.json({ id: "offline-response", object: "response", status: "completed", output: [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "offline answer" }] },
  ] })
}
`)
  await writeFile(path.join(bin, "codex"), `#!/usr/bin/env node
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
setTimeout(() => process.exit(1), 8000).unref()
;(async () => {
  const args = process.argv.slice(2)
  const provider = args.find(arg => arg.startsWith("model_providers.copilot_bridge="))
  assert.ok(provider, "missing provider configuration")
  const baseURL = JSON.parse(provider.match(/base_url=("[^"]+")/)[1])
  assert.equal(new URL(baseURL).hostname, "127.0.0.1")
  assert.equal(new URL(baseURL).pathname, "/v1")
  assert.equal(process.env.OPENAI_API_KEY, "dummy")
  const health = await fetch(new URL("/health", baseURL))
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { service: "codex-copilot-bridge", version: ${JSON.stringify(version)}, status: "ok" })
  const models = await fetch(baseURL + "/models")
  assert.equal(models.status, 200)
  assert.ok((await models.json()).models.some(model => model.id === "offline-model"))
  const cache = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, "models_cache.json"), "utf8"))
  assert.deepEqual(cache.models.map(model => model.slug), ["offline-model"])
  const response = await fetch(baseURL + "/responses", {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ model: "offline-model", input: "offline prompt", stream: false }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { id: "offline-response", object: "response", status: "completed", output: [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "offline answer" }] },
  ] })
  if (process.env.MOCK_WAIT_FOR_SIGNAL) {
    process.once("SIGTERM", () => { console.log("received SIGTERM"); process.exit(42) })
    setInterval(() => {}, 1000)
  }
  console.log(JSON.stringify({ baseURL, args, pid: process.pid, codexHome: process.env.CODEX_HOME }))
  if (!process.env.MOCK_WAIT_FOR_SIGNAL) process.exitCode = 23
})().catch(error => { console.error(error); process.exit(1) })
`, { mode: 0o755 })
  return { ...context, command: [process.execPath, "--preload", preload, path.join(root, "src", "cli.ts"), "ghcodex"] }
}

test("wrappers select default profiles and forward arguments verbatim after provider configuration", () => {
  const baseURL = "http://127.0.0.1:12345/v1"
  const args = ["exec", "--model", "model-name", "-c", 'key="value"', "arg with spaces", "", "$(not-a-shell)"]
  for (const mode of modes) {
    const original = [...args]
    expect(codexArguments(mode, args, baseURL)).toEqual({ needsBridge: true, args: [
      "--profile", mode === "ghcodex" ? "copilot" : "claudex",
      "-c", 'model_provider="copilot_bridge"',
      "-c", `model_providers.copilot_bridge={name="Copilot Bridge",base_url=${JSON.stringify(baseURL)},env_key="OPENAI_API_KEY",wire_api="responses"}`,
      ...(mode === "claudex" ? ["-c", 'web_search="disabled"'] : []), ...args,
    ] })
    expect(args).toEqual(original)
    expect(codexArguments(mode, [], baseURL).needsBridge).toBe(true)
  }
})

test("custom profiles suppress the default for long, short, attached and equals forms", () => {
  for (const mode of modes) {
    for (const profile of [["--profile", "custom"], ["--profile=custom"], ["-p", "custom"], ["-pcustom"], ["-p=custom"]]) {
      const args = ["exec", ...profile, "prompt"]
      const invocation = codexArguments(mode, args, "http://127.0.0.1:12345/v1")
      expect(invocation.needsBridge).toBe(true)
      expect(invocation.args[0]).toBe("-c")
      expect(invocation.args.slice(-args.length)).toEqual(args)
      expect(invocation.args).not.toContain("copilot")
      expect(invocation.args).not.toContain("claudex")
    }
  }
})

test("local utility commands bypass the bridge while services retain provider overrides without profiles", () => {
  const bypass = ["login", "logout", "completion", "update", "doctor", "--help", "-h", "--version", "-V"]
  for (const mode of modes) {
    for (const command of bypass) {
      const args = [command, "arg with spaces", ""]
      expect(codexArguments(mode, args, "unused")).toEqual({ needsBridge: false, args })
    }
    for (const args of [["debug"], ["debug", "other"], ["app-server"], ["mcp-server"], ["app"], ["exec-server"]]) {
      const invocation = codexArguments(mode, args, "http://127.0.0.1/v1")
      expect(invocation.needsBridge).toBe(true)
      expect(invocation.args[0]).toBe("-c")
      expect(invocation.args).not.toContain("--profile")
    }
    for (const args of [["debug", "prompt-input"], ["exec", "prompt"], ["resume"], ["review"]]) {
      expect(codexArguments(mode, args, "http://127.0.0.1/v1").needsBridge).toBe(true)
    }
  }
})

test("model caches filter by endpoint rather than name and preserve discovered and cached capabilities", () => {
  const cache = { revision: "keep", models: [
    { slug: "fallback", supports_search_tool: true, web_search_tool_type: "text_and_image", supports_parallel_tool_calls: true },
    { slug: "claude-responses", supports_search_tool: false, web_search_tool_type: "text", shell_type: "shell_command", context_window: 1 },
    { id: "messages-only", shell_type: "exec_command", supports_search_tool: true },
  ] }
  const models: CodexModelTemplate[] = [
    { slug: "claude-responses", supported_endpoints: [" /V1/Responses "], context_window: 200000, max_output_tokens: 32000, input_modalities: ["text", "image"], supported_reasoning_levels: [{ effort: "high" }] },
    { slug: "dual", supported_endpoints: ["/responses", "/v1/messages"] },
    { id: "messages-only", supported_endpoints: ["messages"], context_window: 100000, supports_reasoning_summaries: false },
    { slug: "chat-only", supported_endpoints: ["/chat/completions"] },
    { slug: "unknown" },
  ]
  const original = structuredClone({ cache, models })
  const gh = mergeModelCache(cache, models, "ghcodex")
  expect(gh.models.map((model: CodexModelTemplate) => model.slug ?? model.id)).toEqual(["claude-responses", "dual"])
  expect(gh.models[0]).toMatchObject({ ...models[0], supports_search_tool: false, web_search_tool_type: "text", supports_parallel_tool_calls: true, shell_type: "shell_command" })
  expect(gh.models[1]).toMatchObject({ supports_search_tool: true, web_search_tool_type: "text_and_image" })
  expect(gh).toMatchObject({ revision: "keep" })
  expect(Number.isNaN(Date.parse(gh.fetched_at))).toBe(false)
  const claude = mergeModelCache(cache, models, "claudex")
  expect(claude.models).toHaveLength(1)
  expect(claude.models[0]).toMatchObject({ ...models[2], shell_type: "exec_command", supports_parallel_tool_calls: true, supports_search_tool: false })
  expect(claude.models[0].web_search_tool_type).toBeUndefined()
  expect(JSON.stringify(claude.models[0])).not.toContain("web_search_tool_type")
  expect({ cache, models }).toEqual(original)
})

test("model cache merging handles missing templates and no compatible models", () => {
  for (const mode of modes) expect(mergeModelCache({}, [], mode).models).toEqual([])
  const response = { slug: "response", supported_endpoints: ["/responses"] }
  expect(mergeModelCache({}, [response], "ghcodex").models[0]).toMatchObject({ ...response, supports_search_tool: true, web_search_tool_type: "text_and_image" })
  expect(mergeModelCache({}, [response], "claudex").models).toEqual([])
})

test("help and version succeed with absent or malformed auth and no Codex in PATH", async () => {
  const { env, run } = await fixture()
  for (const malformed of [false, true]) {
    if (malformed) await writeFile(env.OPENCODE_AUTH_FILE, "not-json-secret-marker")
    for (const flag of ["--help", "-h", "--version", "-V"]) {
      const result = run([flag])
      expect(result.status).toBe(0)
      expect(result.stderr).toBe("")
      if (["--help", "-h"].includes(flag)) expect(result.stdout).toContain("Usage: codex-copilot-bridge")
      else expect(result.stdout.trim()).toBe(`codex-copilot-bridge ${version}`)
    }
  }
})

test("CLI rejects unknown commands, extra arguments and invalid ports before credentials", async () => {
  const { run } = await fixture()
  for (const args of [["unknown"], ["--json"], ["serve", "extra"], ["doctor", "--json"], ["models", "--bad"], ["models", "--json", "extra"]]) {
    const result = run(args)
    expect(result.status).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Unknown command or argument")
    expect(result.stderr).not.toContain("credentials")
  }
  for (const PORT of ["-1", "65536", "1.5", "not-a-port"]) {
    const result = run(["serve"], { PORT })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("PORT must be an integer between 0 and 65535")
  }
})

test("wrapper version dispatch reaches mock Codex without auth and propagates exit status", async () => {
  const { bin, run } = await fixture()
  const node = Bun.which("node")
  expect(node).not.toBeNull()
  await symlink(node!, path.join(bin, "node"))
  await writeFile(path.join(bin, "codex"), '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))\nprocess.exit(Number(process.env.MOCK_CODEX_EXIT || 0))\n', { mode: 0o755 })
  for (const mode of modes) {
    for (const code of [0, 23]) {
      const args = ["--version", "arg with spaces", "", "$(not-a-shell)"]
      const result = run([mode, ...args], { MOCK_CODEX_EXIT: String(code) })
      expect(result.status).toBe(code)
      expect(JSON.parse(result.stdout)).toEqual(args)
      expect(result.stderr).toBe("")
    }
  }
})

test("wrapper runs offline inference, writes only its fixture cache and stops the server on child exit", async () => {
  const { command, directory, env } = await inferenceFixture()
  const args = ["exec", "--model", "offline-model", "arg with spaces", "", "$(not-a-shell)"]
  const cachePath = path.join(env.CODEX_HOME, "models_cache.json")
  expect(await Bun.file(cachePath).exists()).toBe(false)
  const result = spawnSync(command[0], [...command.slice(1), ...args], {
    cwd: directory, env, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
  })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.stderr).toBe("")
  expect(result.status).toBe(23)
  const output = JSON.parse(result.stdout)
  expect(output.codexHome).toBe(env.CODEX_HOME)
  expect(output.args).toEqual(codexArguments("ghcodex", args, output.baseURL).args)
  const cache = await Bun.file(cachePath).json()
  expect(cache.models).toHaveLength(1)
  expect(cache.models[0]).toMatchObject({ slug: "offline-model", context_window: 123456, supported_endpoints: ["/responses"] })
  expect(Number.isNaN(Date.parse(cache.fetched_at))).toBe(false)
  expect(await Bun.file(path.join(env.HOME, ".codex", "models_cache.json")).exists()).toBe(false)
  await expect(fetch(new URL("/health", output.baseURL), { signal: AbortSignal.timeout(1000) })).rejects.toThrow()
}, 15_000)

test("wrapper forwards SIGTERM to Codex and shuts down its loopback server", async () => {
  const { command, directory, env } = await inferenceFixture()
  const child = spawn(command[0], command.slice(1), {
    cwd: directory, env: { ...env, MOCK_WAIT_FOR_SIGNAL: "1" }, stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000, killSignal: "SIGKILL",
  })
  const lines = createInterface({ input: child.stdout })
  const signal = AbortSignal.timeout(10_000)
  const closed = once(child, "close")
  let stderr = ""
  let stdout = ""
  let codexPID: number | undefined
  child.stderr.on("data", data => { stderr += data })
  child.stdout.on("data", data => { stdout += data })
  try {
    const [line] = await Promise.race([
      once(lines, "line", { signal }),
      closed.then(() => { throw new Error(`Wrapper exited before Codex was ready: ${stderr}`) }),
    ])
    const output = JSON.parse(line)
    codexPID = output.pid
    const health = await fetch(new URL("/health", output.baseURL), { signal })
    expect(health.status).toBe(200)
    expect(child.kill("SIGTERM")).toBe(true)
    expect(await closed).toEqual([42, null])
    expect(stdout).toContain("received SIGTERM")
    expect(stderr).toBe("")
    await expect(fetch(new URL("/health", output.baseURL), { signal: AbortSignal.timeout(1000) })).rejects.toThrow()
  } finally {
    lines.close()
    if (child.exitCode === null && child.signalCode === null) {
      if (codexPID) { try { process.kill(codexPID, "SIGKILL") } catch {} }
      child.kill("SIGKILL")
    }
    await closed
  }
}, 15_000)

test("legacy executable shim and claudex symlink forward modes and arguments through PATH", async () => {
  const { directory, bin, env } = await fixture()
  const node = Bun.which("node")
  expect(node).not.toBeNull()
  await symlink(node!, path.join(bin, "node"))
  await writeFile(path.join(bin, "codex-copilot-bridge"), '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))\nprocess.exit(23)\n', { mode: 0o755 })
  const shim = path.join(root, "bin", "ghcodex")
  const alias = path.join(bin, "claudex")
  await symlink(shim, alias)
  const args = ["exec", "--profile", "custom", "arg with spaces", "", "$(not-a-shell)"]
  for (const [executable, mode] of [[shim, "ghcodex"], [alias, "claudex"]]) {
    const result = spawnSync(executable, args, { cwd: directory, env, encoding: "utf8", timeout: 10_000 })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status).toBe(23)
    expect(result.stderr).toBe("")
    expect(JSON.parse(result.stdout)).toEqual([mode, ...args])
  }
})

test("missing Codex produces an actionable error without accessing credentials", async () => {
  const { run } = await fixture()
  for (const mode of modes) {
    const result = run([mode, "--version"])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("codex not found in PATH")
    expect(result.stderr).not.toContain("credentials")
  }
})

test("credential errors redact invalid auth contents and do not attempt discovery", async () => {
  const { env, run } = await fixture()
  const secret = "FAKE-TOKEN-MUST-NOT-APPEAR-IN-ERRORS"
  for (const content of [`{"github-copilot":"${secret}"`, JSON.stringify({ "github-copilot": { type: "invalid", refresh: secret } })]) {
    await writeFile(env.OPENCODE_AUTH_FILE, content)
    for (const args of [["serve"], ["models", "--json"], ["doctor"]]) {
      const result = run(args)
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/Cannot read Copilot credentials|GitHub Copilot OAuth credential not found/)
      expect(result.stdout + result.stderr).not.toContain(secret)
      expect(result.stderr).not.toContain("at readCopilotAuth")
    }
  }
})

test("health stays local and healthy even when mocked upstream discovery fails", async () => {
  const upstream = mock(async () => { throw new Error("mock upstream unavailable") })
  const discovery = mock(async () => {
    await upstream()
    return []
  })
  const templates = mock(async () => [])
  const handler = createHandler("https://upstream.invalid", upstream, discovery, templates)
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler })
  try {
    for (const afterFailure of [false, true]) {
      if (afterFailure) {
        const failed = await fetch(new URL("/v1/models", server.url))
        expect(failed.status).toBe(502)
        expect(await failed.json()).toEqual({ error: { message: "mock upstream unavailable" } })
      }
      const response = await fetch(new URL("/health", server.url))
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("application/json")
      expect(await response.json()).toEqual({ service: "codex-copilot-bridge", version, status: "ok" })
      expect(upstream).toHaveBeenCalledTimes(afterFailure ? 1 : 0)
      expect(discovery).toHaveBeenCalledTimes(afterFailure ? 1 : 0)
      expect(templates).not.toHaveBeenCalled()
    }
  } finally {
    server.stop(true)
  }
})
