export type CopilotModel = {
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

export type CopilotEndpointSelection =
  | { kind: "responses"; model: CopilotModel }
  | { kind: "messages"; model: CopilotModel }
  | { kind: "unsupported"; model?: CopilotModel; message: string }

export type CodexModelTemplate = { slug?: string; [key: string]: unknown }

type ModelsCache = {
  expiresAt: number
  models: CopilotModel[]
}

const reasoningDescriptions: Record<string, string> = {
  none: "No reasoning",
  minimal: "Minimal reasoning",
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth for everyday tasks",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth for complex problems",
  max: "Maximum reasoning depth",
}

const modelsCacheTtlMs = 30_000
let modelsCache: ModelsCache | undefined

function normalizeEndpoint(endpoint: string) {
  const value = endpoint.trim().toLowerCase()
  if (!value.startsWith("/")) return `/${value}`
  return value
}

export function endpointIsSupported(model: CopilotModel | undefined, endpoint: "/responses" | "/v1/messages") {
  const endpoints = model?.supported_endpoints?.map(normalizeEndpoint) ?? []
  if (endpoint === "/responses") {
    return endpoints.includes("/responses") || endpoints.includes("/v1/responses")
  }
  return endpoints.includes("/v1/messages") || endpoints.includes("/messages")
}

export async function loadCopilotModels(fetchModels: () => Promise<CopilotModel[]>, now = Date.now()) {
  if (modelsCache && modelsCache.expiresAt > now) return modelsCache.models
  const models = await fetchModels()
  modelsCache = { models, expiresAt: now + modelsCacheTtlMs }
  return models
}

export function clearCopilotModelsCache() {
  modelsCache = undefined
}

function codexModelShape(item: CopilotModel) {
  if (!item.id) return undefined
  if (item.policy?.state === "disabled") return undefined
  if (!endpointIsSupported(item, "/responses") && !endpointIsSupported(item, "/v1/messages")) return undefined

  const supportedReasoningLevels = (item.capabilities?.supports?.reasoning_effort ?? []).map((effort) => ({
    effort,
    description: reasoningDescriptions[effort] ?? effort,
  }))

  return {
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
    priority: item.model_picker_enabled ? 50 : 100,
    context_window: item.capabilities?.limits?.max_context_window_tokens,
    max_context_window: item.capabilities?.limits?.max_context_window_tokens,
    max_context_window_tokens: item.capabilities?.limits?.max_context_window_tokens,
    max_output_tokens: item.capabilities?.limits?.max_output_tokens,
    max_prompt_tokens: item.capabilities?.limits?.max_prompt_tokens,
  }
}

export function buildCodexModels(available: CopilotModel[], templates: CodexModelTemplate[] = []) {
  const byID = new Map(available.flatMap((item) => (item.id ? [[item.id, item] as const] : [])))
  const seen = new Set<string>()
  const models: CodexModelTemplate[] = []
  const fallbackTemplate = templates[0]

  function mergeWithTemplate(template: CodexModelTemplate | undefined, override: NonNullable<ReturnType<typeof codexModelShape>>) {
    return {
      ...(fallbackTemplate ?? {}),
      ...(template ?? {}),
      ...override,
      default_reasoning_level: override.default_reasoning_level ?? template?.default_reasoning_level,
      context_window: override.context_window ?? template?.context_window ?? fallbackTemplate?.context_window,
      max_context_window: override.max_context_window ?? template?.max_context_window ?? fallbackTemplate?.max_context_window,
      max_context_window_tokens: override.max_context_window_tokens ?? template?.max_context_window_tokens ?? fallbackTemplate?.max_context_window_tokens,
      max_prompt_tokens: override.max_prompt_tokens ?? template?.max_prompt_tokens ?? fallbackTemplate?.max_prompt_tokens,
      max_output_tokens: override.max_output_tokens ?? template?.max_output_tokens ?? fallbackTemplate?.max_output_tokens,
    }
  }

  for (const template of templates) {
    if (!template.slug) continue
    const copilot = byID.get(template.slug)
    if (!copilot) continue
    const override = codexModelShape(copilot)
    if (!override) continue
    seen.add(template.slug)
    models.push(mergeWithTemplate(template, override))
  }

  for (const model of available) {
    if (!model.id || seen.has(model.id)) continue
    const shaped = codexModelShape(model)
    if (!shaped) continue
    seen.add(model.id)
    models.push(mergeWithTemplate(fallbackTemplate, shaped))
  }

  return models
}

export function selectCopilotEndpoint(models: CopilotModel[], modelID: unknown): CopilotEndpointSelection {
  if (typeof modelID !== "string" || modelID.length === 0) {
    return { kind: "unsupported", message: "Responses request is missing a string model." }
  }

  const model = models.find((item) => item.id === modelID)
  if (!model) {
    return { kind: "unsupported", message: `Copilot model '${modelID}' was not found in /models metadata.` }
  }

  if (endpointIsSupported(model, "/responses")) return { kind: "responses", model }
  if (endpointIsSupported(model, "/v1/messages")) return { kind: "messages", model }

  const endpoints = model.supported_endpoints?.length ? model.supported_endpoints.join(", ") : "none"
  return {
    kind: "unsupported",
    model,
    message: `Copilot model '${modelID}' does not support /responses or /v1/messages. Supported endpoints: ${endpoints}.`,
  }
}
