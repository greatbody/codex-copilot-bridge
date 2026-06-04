import path from "node:path"

const port = Number(process.env.PORT || 18787)
const baseURL = "https://api.githubcopilot.com"
const apiVersion = "2026-06-01"
const authFile = process.env.OPENCODE_AUTH_FILE ?? path.join(process.env.HOME ?? "", ".local/share/opencode/auth.json")
const codexModelsCacheFile = path.join(process.env.HOME ?? "", ".codex/models_cache.json")

type AuthFile = Record<string, { type?: string; refresh?: string; enterpriseUrl?: string } | undefined>
type CopilotModel = {
  id?: string
  name?: string
  model_picker_enabled?: boolean
  supported_endpoints?: string[]
  capabilities?: {
    limits?: {
      max_context_window_tokens?: number
      max_output_tokens?: number
      max_prompt_tokens?: number
    }
    supports?: {
      tool_calls?: boolean
      reasoning_effort?: string[]
    }
  }
  policy?: {
    state?: string
  }
}
type CodexModelCache = {
  models?: Array<{ slug?: string; [key: string]: unknown }>
}

const reasoningDescriptions: Record<string, string> = {
  none: "No reasoning",
  minimal: "Minimal reasoning",
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth for everyday tasks",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth for complex problems",
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

function codexModelShape(item: CopilotModel) {
  if (!item.id) return []
  if (item.policy?.state === "disabled") return []
  if (item.capabilities?.supports?.tool_calls === undefined) return []
  const supportedReasoningLevels = (item.capabilities?.supports?.reasoning_effort ?? []).map((effort) => ({
    effort,
    description: reasoningDescriptions[effort] ?? effort,
  }))
  return [
    {
      slug: item.id,
      display_name: item.name ?? item.id,
      description: item.name ?? item.id,
      default_reasoning_level: supportedReasoningLevels.some((item) => item.effort === "medium")
        ? "medium"
        : supportedReasoningLevels[0]?.effort,
      supported_reasoning_levels: supportedReasoningLevels,
      object: "model",
      id: item.id,
      model_picker_enabled: item.model_picker_enabled ?? false,
      supported_endpoints: item.supported_endpoints ?? [],
      visibility: item.model_picker_enabled ? "list" : "hidden",
      supported_in_api: true,
      context_window: item.capabilities?.limits?.max_context_window_tokens,
      max_context_window: item.capabilities?.limits?.max_context_window_tokens,
      max_context_window_tokens: item.capabilities?.limits?.max_context_window_tokens,
      max_output_tokens: item.capabilities?.limits?.max_output_tokens,
      max_prompt_tokens: item.capabilities?.limits?.max_prompt_tokens,
    },
  ]
}

async function codexModelTemplates(available: CopilotModel[]) {
  const byID = new Map(available.flatMap((item) => (item.id ? [[item.id, item] as const] : [])))
  const cache = (await Bun.file(codexModelsCacheFile).json().catch(() => undefined)) as CodexModelCache | undefined
  const models = (cache?.models ?? []).flatMap((item) => {
    if (!item.slug) return []
    const copilot = byID.get(item.slug)
    if (!copilot) return []
    const [override] = codexModelShape(copilot)
    if (!override) return []
    return [
      {
        ...item,
        description: override.description,
        supported_reasoning_levels: override.supported_reasoning_levels,
        default_reasoning_level: override.default_reasoning_level ?? item.default_reasoning_level,
        context_window: override.context_window ?? item.context_window,
        max_context_window: override.max_context_window ?? item.max_context_window,
        max_context_window_tokens: override.max_context_window_tokens,
        max_prompt_tokens: override.max_prompt_tokens,
        max_output_tokens: override.max_output_tokens,
      },
    ]
  })
  if (models.length > 0) return models
  return available.flatMap(codexModelShape)
}

function sanitizeResponsesBody(raw: string) {
  const body = JSON.parse(raw) as { tools?: Array<{ type?: string }>; [key: string]: unknown }
  if (Array.isArray(body.tools)) {
    body.tools = body.tools.filter((tool) => tool.type !== "image_generation")
  }
  return JSON.stringify(body)
}

const initialAuth = await readCopilotAuth()
const resolvedBaseURL = resolveBaseURL(initialAuth.enterpriseUrl)

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url)

    if (request.method === "GET" && url.pathname === "/v1/models") {
      const response = await copilotFetch(`${resolvedBaseURL}/models`)
      if (!response.ok) {
        return json({ error: { message: `Copilot models failed: ${response.status}` } }, response.status)
      }
      const body = (await response.json()) as { data?: CopilotModel[] }
      const models = await codexModelTemplates(body.data ?? [])
      return json({ object: "list", data: models, models })
    }

    if (request.method === "POST" && url.pathname === "/v1/responses") {
      const response = await copilotFetch(`${resolvedBaseURL}/responses`, {
        method: "POST",
        headers: {
          "content-type": request.headers.get("content-type") || "application/json",
          accept: request.headers.get("accept") || "text/event-stream",
        },
        body: sanitizeResponsesBody(await request.text()),
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
