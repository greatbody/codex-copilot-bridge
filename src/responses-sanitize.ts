type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

type ResponsesBody = {
  model?: unknown
  service_tier?: unknown
  [key: string]: unknown
}

export function rewriteCopilotFastResponsesRequest(body: ResponsesBody): ResponsesBody {
  if (body.service_tier !== "fast" && body.service_tier !== "priority" && body.service_tier !== "ultrafast") return body
  if (body.model !== "gpt-5.6-sol" && body.model !== "gpt-5.6-sol-fast") return body

  const { service_tier: _serviceTier, ...rewritten } = body
  return { ...rewritten, model: "gpt-5.6-sol-fast" }
}

function stripUnsupportedResponsesFields(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(stripUnsupportedResponsesFields)
  }

  if (value && typeof value === "object") {
    const cleaned: { [key: string]: JsonValue } = {}
    for (const [key, child] of Object.entries(value)) {
      if (key === "internal_chat_message_metadata_passthrough") continue
      cleaned[key] = stripUnsupportedResponsesFields(child)
    }
    return cleaned
  }

  return value
}

export function sanitizeResponsesBody(raw: string) {
  const body = stripUnsupportedResponsesFields(JSON.parse(raw) as JsonValue) as {
    tools?: Array<{ type?: string }>
    [key: string]: unknown
  }

  if (Array.isArray(body.tools)) {
    body.tools = body.tools.filter((tool) => tool.type !== "image_generation")
  }

  return JSON.stringify(body)
}
