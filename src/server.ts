import path from "node:path"
import { anthropicStreamToResponsesStream, anthropicToResponses, responsesToAnthropicMessages } from "./anthropic-adapter"
import { buildCodexModels, loadCopilotModels, selectCopilotEndpoint, type CodexModelTemplate, type CopilotModel } from "./copilot"

const port = Number(process.env.PORT || 18787)
const baseURL = "https://api.githubcopilot.com"
const apiVersion = "2026-06-01"
const authFile = process.env.OPENCODE_AUTH_FILE ?? path.join(process.env.HOME ?? "", ".local/share/opencode/auth.json")
const codexModelsCacheFile = path.join(process.env.HOME ?? "", ".codex/models_cache.json")

type AuthFile = Record<string, { type?: string; refresh?: string; enterpriseUrl?: string } | undefined>
type CodexModelCache = {
  models?: CodexModelTemplate[]
}

function normalizeDomain(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "")
}

function resolveBaseURL(enterpriseUrl?: string) {
  return enterpriseUrl ? `https://copilot-api.${normalizeDomain(enterpriseUrl)}` : baseURL
}

async function readCopilotAuth() {
  const parsed = (await Bun.file(authFile).json()) as AuthFile
  const auth = parsed["github-copilot"]
  if (auth?.type !== "oauth" || !auth.refresh) {
    throw new Error(`GitHub Copilot OAuth credential not found in ${authFile}`)
  }
  return auth
}

async function copilotFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const auth = await readCopilotAuth()
  const headers = new Headers(init.headers)
  headers.set("authorization", `Bearer ${auth.refresh}`)
  headers.set("user-agent", "codex-copilot-bridge/0.1")
  headers.set("openai-intent", "conversation-edits")
  headers.set("x-github-api-version", apiVersion)
  headers.delete("x-api-key")
  return fetch(input, { ...init, headers })
}

function json(data: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

async function codexModelTemplates(available: CopilotModel[]) {
  const cache = (await Bun.file(codexModelsCacheFile).json().catch(() => undefined)) as CodexModelCache | undefined
  return buildCodexModels(available, cache?.models ?? [])
}

function sanitizeResponsesBody(raw: string) {
  const body = JSON.parse(raw) as { tools?: Array<{ type?: string }>; [key: string]: unknown }
  if (Array.isArray(body.tools)) {
    body.tools = body.tools.filter((tool) => tool.type !== "image_generation")
  }
  return JSON.stringify(body)
}

async function fetchCopilotModels() {
  const response = await copilotFetch(`${resolvedBaseURL}/models`)
  if (!response.ok) {
    throw new Error(`Copilot models failed: ${response.status}`)
  }
  const body = (await response.json()) as { data?: CopilotModel[] }
  return body.data ?? []
}

const initialAuth = await readCopilotAuth()
const resolvedBaseURL = resolveBaseURL(initialAuth.enterpriseUrl)

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url)

    if (request.method === "GET" && url.pathname === "/v1/models") {
      let available: CopilotModel[]
      try {
        available = await loadCopilotModels(fetchCopilotModels)
      } catch (error) {
        return json({ error: { message: error instanceof Error ? error.message : "Copilot models failed" } }, 502)
      }
      const models = await codexModelTemplates(available)
      return json({ object: "list", data: models, models })
    }

    if (request.method === "POST" && url.pathname === "/v1/responses") {
      const rawBody = await request.text()
      let body: Record<string, unknown>
      try {
        body = JSON.parse(rawBody) as Record<string, unknown>
      } catch {
        return json({ error: { message: "Request body must be valid JSON." } }, 400)
      }

      let models: CopilotModel[]
      try {
        models = await loadCopilotModels(fetchCopilotModels)
      } catch (error) {
        return json({ error: { message: error instanceof Error ? error.message : "Copilot models failed" } }, 502)
      }

      const selection = selectCopilotEndpoint(models, body.model)
      if (selection.kind === "unsupported") {
        return json({ error: { message: selection.message } }, selection.model ? 400 : 404)
      }

      if (selection.kind === "messages") {
        const converted = responsesToAnthropicMessages(body)
        if (!converted.ok) return json({ error: { message: converted.message } }, converted.status)

        const response = await copilotFetch(`${resolvedBaseURL}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: converted.value.stream ? "text/event-stream" : "application/json",
          },
          body: JSON.stringify(converted.value),
        })

        if (!response.ok) {
          const headers = new Headers(response.headers)
          headers.delete("content-encoding")
          headers.delete("content-length")
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          })
        }

        if (converted.value.stream) {
          return new Response(anthropicStreamToResponsesStream(response.body, converted.value.model), {
            headers: { "content-type": "text/event-stream" },
          })
        }

        return json(anthropicToResponses(await response.json(), converted.value.model))
      }

      const response = await copilotFetch(`${resolvedBaseURL}/responses`, {
        method: "POST",
        headers: {
          "content-type": request.headers.get("content-type") || "application/json",
          accept: request.headers.get("accept") || "text/event-stream",
        },
        body: sanitizeResponsesBody(rawBody),
      })
      const headers = new Headers(response.headers)
      headers.delete("content-encoding")
      headers.delete("content-length")
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    }

    return json({ error: { message: "not found" } }, 404)
  },
})

console.error(`codex-copilot-bridge listening on http://127.0.0.1:${port}/v1`)
console.error(`using Copilot auth from ${authFile}`)
