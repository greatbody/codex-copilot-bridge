type JsonObject = Record<string, unknown>

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string | AnthropicContentBlock[]; is_error?: boolean }

type AnthropicMessage = {
  role: "user" | "assistant"
  content: string | AnthropicContentBlock[]
}

export type AnthropicMessagesRequest = {
  model: string
  messages: AnthropicMessage[]
  system?: string
  max_tokens?: number
  stream?: boolean
  tools?: Array<{ name: string; description?: string; input_schema: unknown }>
  tool_choice?: { type: "auto" | "any" | "tool"; name?: string }
  temperature?: number
  top_p?: number
  metadata?: unknown
  stop_sequences?: string[]
}

type AdapterResult<T> = { ok: true; value: T } | { ok: false; status: number; message: string }

const hostedToolTypes = new Set([
  "image_generation",
  "web_search",
  "web_search_preview",
  "file_search",
  "computer_use",
  "computer_use_preview",
  "code_interpreter",
])

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function asText(value: unknown) {
  if (typeof value === "string") return value
  return JSON.stringify(value)
}

function extractDataURL(value: string) {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(value)
  if (!match) return undefined
  return { mediaType: match[1], data: match[2] }
}

function textBlock(text: string): AnthropicContentBlock[] {
  return text.length > 0 ? [{ type: "text", text }] : []
}

function inputPartToAnthropic(part: unknown): AnthropicContentBlock[] {
  if (typeof part === "string") return textBlock(part)
  if (!isObject(part)) return textBlock(asText(part))

  const type = stringValue(part.type)
  if (type === "reasoning" || type === "encrypted_reasoning") return []
  if (type === "input_text" || type === "output_text" || type === "text") {
    return textBlock(stringValue(part.text) ?? "")
  }

  if (type === "input_image" || type === "image") {
    const imageURL = stringValue(part.image_url) ?? stringValue(part.url)
    if (!imageURL) return []
    const dataURL = extractDataURL(imageURL)
    return [
      {
        type: "image",
        source: dataURL
          ? { type: "base64", media_type: dataURL.mediaType, data: dataURL.data }
          : { type: "url", url: imageURL },
      },
    ]
  }

  if (type === "tool_result") {
    const toolUseID = stringValue(part.tool_use_id) ?? stringValue(part.call_id)
    if (!toolUseID) return []
    return [{ type: "tool_result", tool_use_id: toolUseID, content: asText(part.content ?? part.output ?? "") }]
  }

  return textBlock(asText(part))
}

function messageContentToAnthropic(content: unknown): AnthropicContentBlock[] {
  if (typeof content === "string") return textBlock(content)
  if (Array.isArray(content)) return content.flatMap(inputPartToAnthropic)
  if (content === undefined || content === null) return []
  return inputPartToAnthropic(content)
}

function responseItemToAnthropic(item: unknown): AnthropicMessage[] {
  if (typeof item === "string") return [{ role: "user", content: textBlock(item) }]
  if (!isObject(item)) return [{ role: "user", content: textBlock(asText(item)) }]

  const type = stringValue(item.type)
  if (type === "reasoning" || type === "encrypted_reasoning") return []
  if (type === "function_call_output") {
    const callID = stringValue(item.call_id)
    if (!callID) return []
    return [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: callID, content: asText(item.output ?? "") }],
      },
    ]
  }

  if (type === "function_call") {
    const callID = stringValue(item.call_id) ?? stringValue(item.id)
    const name = stringValue(item.name)
    if (!callID || !name) return []
    let input: unknown = item.arguments ?? {}
    if (typeof input === "string") {
      try {
        input = JSON.parse(input)
      } catch {
        input = { arguments: input }
      }
    }
    return [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: callID, name, input }],
      },
    ]
  }

  const rawRole = stringValue(item.role)
  if (rawRole === "tool") {
    const callID = stringValue(item.call_id) ?? stringValue(item.tool_call_id)
    if (!callID) return []
    return [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: callID, content: asText(item.output ?? item.content ?? "") }],
      },
    ]
  }

  const role = rawRole === "assistant" ? "assistant" : "user"
  const content = messageContentToAnthropic(item.content ?? item.text ?? item.output)
  return [{ role, content }]
}

function mergeAdjacentMessages(messages: AnthropicMessage[]) {
  const merged: AnthropicMessage[] = []
  for (const message of messages) {
    if (Array.isArray(message.content) && message.content.length === 0) continue
    const previous = merged.at(-1)
    if (!previous || previous.role !== message.role || typeof previous.content === "string" || typeof message.content === "string") {
      merged.push(message)
      continue
    }
    previous.content.push(...message.content)
  }
  return merged
}

function hasToolUse(content: AnthropicMessage["content"]) {
  return Array.isArray(content) && content.some((block) => block.type === "tool_use")
}

function removeTrailingAssistantPrefill(messages: AnthropicMessage[]) {
  const normalized = [...messages]
  while (normalized.at(-1)?.role === "assistant" && !hasToolUse(normalized.at(-1)?.content ?? [])) {
    normalized.pop()
  }
  return normalized
}

function convertTools(tools: unknown): AdapterResult<AnthropicMessagesRequest["tools"]> {
  if (tools === undefined) return { ok: true, value: undefined }
  if (!Array.isArray(tools)) return { ok: false, status: 400, message: "Responses tools must be an array." }

  const converted: NonNullable<AnthropicMessagesRequest["tools"]> = []
  for (const tool of tools) {
    if (!isObject(tool)) continue
    const type = stringValue(tool.type)
    if (type === "image_generation") continue
    if (type && (hostedToolTypes.has(type) || type.startsWith("web_search") || type.startsWith("computer_use"))) {
      return { ok: false, status: 400, message: `OpenAI hosted tool '${type}' is not supported by the Claude messages adapter.` }
    }
    if (type !== "function") continue

    const functionDef = isObject(tool.function) ? tool.function : tool
    const name = stringValue(functionDef.name)
    if (!name) return { ok: false, status: 400, message: "Function tools must include a name." }
    converted.push({
      name,
      description: stringValue(functionDef.description),
      input_schema: functionDef.parameters ?? { type: "object", properties: {} },
    })
  }

  return { ok: true, value: converted.length > 0 ? converted : undefined }
}

function convertToolChoice(toolChoice: unknown): AdapterResult<AnthropicMessagesRequest["tool_choice"]> {
  if (toolChoice === undefined || toolChoice === null || toolChoice === "auto") return { ok: true, value: { type: "auto" } }
  if (toolChoice === "required") return { ok: true, value: { type: "any" } }
  if (toolChoice === "none") return { ok: true, value: undefined }
  if (!isObject(toolChoice)) return { ok: true, value: undefined }

  const type = stringValue(toolChoice.type)
  if (type === "function") {
    const name = stringValue(toolChoice.name) ?? (isObject(toolChoice.function) ? stringValue(toolChoice.function.name) : undefined)
    if (!name) return { ok: false, status: 400, message: "Function tool_choice must include a function name." }
    return { ok: true, value: { type: "tool", name } }
  }
  if (type === "auto") return { ok: true, value: { type: "auto" } }
  if (type === "required") return { ok: true, value: { type: "any" } }
  return { ok: true, value: undefined }
}

export function responsesToAnthropicMessages(body: JsonObject): AdapterResult<AnthropicMessagesRequest> {
  if (typeof body.previous_response_id === "string" && body.previous_response_id.length > 0) {
    return {
      ok: false,
      status: 400,
      message: "previous_response_id persistence is not supported by the Claude messages adapter. Send the full conversation instead.",
    }
  }

  const model = stringValue(body.model)
  if (!model) return { ok: false, status: 400, message: "Responses request is missing a string model." }

  const tools = convertTools(body.tools)
  if (!tools.ok) return tools
  const toolChoice = convertToolChoice(body.tool_choice)
  if (!toolChoice.ok) return toolChoice

  const rawInput = body.input
  const messages = removeTrailingAssistantPrefill(
    mergeAdjacentMessages(Array.isArray(rawInput) ? rawInput.flatMap(responseItemToAnthropic) : responseItemToAnthropic(rawInput ?? "")),
  )

  const request: AnthropicMessagesRequest = {
    model,
    messages: messages.length > 0 ? messages : [{ role: "user", content: "" }],
  }

  const system = [body.instructions, body.system].flatMap((value) => (typeof value === "string" && value ? [value] : []))
  if (system.length > 0) request.system = system.join("\n\n")

  const maxTokens = typeof body.max_output_tokens === "number" ? body.max_output_tokens : body.max_tokens
  request.max_tokens = typeof maxTokens === "number" ? maxTokens : 4096
  if (body.stream === true) request.stream = true
  if (tools.value) request.tools = tools.value
  if (toolChoice.value) request.tool_choice = toolChoice.value
  if (typeof body.temperature === "number") request.temperature = body.temperature
  if (typeof body.top_p === "number") request.top_p = body.top_p
  if (body.metadata !== undefined) request.metadata = body.metadata
  if (Array.isArray(body.stop)) request.stop_sequences = body.stop.filter((item): item is string => typeof item === "string")
  if (typeof body.stop === "string") request.stop_sequences = [body.stop]

  return { ok: true, value: request }
}

function responseOutputFromAnthropic(content: unknown): unknown[] {
  if (!Array.isArray(content)) return []
  const output: unknown[] = []
  const textParts: Array<{ type: "output_text"; text: string; annotations: [] }> = []

  for (const block of content) {
    if (!isObject(block)) continue
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push({ type: "output_text", text: block.text, annotations: [] })
      continue
    }
    if (block.type === "tool_use") {
      output.push({
        type: "function_call",
        id: stringValue(block.id) ?? `fc_${output.length}`,
        call_id: stringValue(block.id) ?? `call_${output.length}`,
        name: stringValue(block.name) ?? "",
        arguments: JSON.stringify(block.input ?? {}),
        status: "completed",
      })
    }
  }

  if (textParts.length > 0) {
    output.unshift({
      type: "message",
      id: "msg_0",
      status: "completed",
      role: "assistant",
      content: textParts,
    })
  }

  return output
}

export function anthropicToResponses(body: unknown, fallbackModel: string) {
  const source = isObject(body) ? body : {}
  const usage = isObject(source.usage) ? source.usage : {}
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : undefined
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : undefined
  const totalTokens = inputTokens !== undefined || outputTokens !== undefined ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined

  return {
    id: stringValue(source.id) ?? `resp_${crypto.randomUUID()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: stringValue(source.model) ?? fallbackModel,
    output: responseOutputFromAnthropic(source.content),
    parallel_tool_calls: true,
    previous_response_id: null,
    store: false,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
    },
  }
}

function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function parseSSEFrames(buffer: string) {
  const frames: string[] = []
  let next = buffer
  while (true) {
    const index = next.indexOf("\n\n")
    if (index === -1) break
    frames.push(next.slice(0, index))
    next = next.slice(index + 2)
  }
  return { frames, rest: next }
}

function parseSSEFrame(frame: string) {
  let event = "message"
  const data: string[] = []
  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (line.startsWith("event:")) event = line.slice(6).trim()
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
  }
  if (data.length === 0) return undefined
  const payload = data.join("\n")
  if (payload === "[DONE]") return { event, data: payload }
  try {
    return { event, data: JSON.parse(payload) as unknown }
  } catch {
    return undefined
  }
}

export function anthropicStreamToResponsesStream(body: ReadableStream<Uint8Array> | null, fallbackModel: string) {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const responseID = `resp_${crypto.randomUUID()}`
  const output: unknown[] = []
  const toolBlocks = new Map<number, { id: string; name: string; arguments: string; outputIndex: number }>()
  let textOutputIndex: number | undefined
  let textContentIndex = 0
  let text = ""
  let model = fallbackModel
  let usage: JsonObject | undefined
  let buffer = ""

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sse("response.created", { type: "response.created", response: { id: responseID, status: "in_progress", model } })))
    },
    async pull(controller) {
      const reader = body?.getReader()
      if (!reader) {
        controller.close()
        return
      }

      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n")
        const parsed = parseSSEFrames(buffer)
        buffer = parsed.rest
        for (const frame of parsed.frames) {
          const message = parseSSEFrame(frame)
          if (!message || message.data === "[DONE]" || !isObject(message.data)) continue
          const data = message.data

          if (data.type === "message_start" && isObject(data.message)) {
            model = stringValue(data.message.model) ?? model
            if (isObject(data.message.usage)) usage = data.message.usage
          }

          if (data.type === "content_block_start" && typeof data.index === "number" && isObject(data.content_block)) {
            const block = data.content_block
            if (block.type === "text") {
              textOutputIndex = output.length
              textContentIndex = 0
              const item = {
                type: "message",
                id: `msg_${textOutputIndex}`,
                status: "in_progress",
                role: "assistant",
                content: [{ type: "output_text", text: "", annotations: [] }],
              }
              output.push(item)
              controller.enqueue(encoder.encode(sse("response.output_item.added", { type: "response.output_item.added", output_index: textOutputIndex, item })))
              controller.enqueue(
                encoder.encode(
                  sse("response.content_part.added", {
                    type: "response.content_part.added",
                    item_id: item.id,
                    output_index: textOutputIndex,
                    content_index: textContentIndex,
                    part: { type: "output_text", text: "", annotations: [] },
                  }),
                ),
              )
            }
            if (block.type === "tool_use") {
              const outputIndex = output.length
              const tool = {
                id: stringValue(block.id) ?? `call_${data.index}`,
                name: stringValue(block.name) ?? "",
                arguments: "",
                outputIndex,
              }
              toolBlocks.set(data.index, tool)
              const item = {
                type: "function_call",
                id: tool.id,
                call_id: tool.id,
                name: tool.name,
                arguments: "",
                status: "in_progress",
              }
              output.push(item)
              controller.enqueue(encoder.encode(sse("response.output_item.added", { type: "response.output_item.added", output_index: outputIndex, item })))
            }
          }

          if (data.type === "content_block_delta" && typeof data.index === "number" && isObject(data.delta)) {
            const delta = data.delta
            if (delta.type === "text_delta" && typeof delta.text === "string" && textOutputIndex !== undefined) {
              text += delta.text
              const item = output[textOutputIndex]
              if (isObject(item) && Array.isArray(item.content) && isObject(item.content[0])) item.content[0].text = text
              controller.enqueue(
                encoder.encode(
                  sse("response.output_text.delta", {
                    type: "response.output_text.delta",
                    item_id: isObject(item) ? item.id : undefined,
                    output_index: textOutputIndex,
                    content_index: textContentIndex,
                    delta: delta.text,
                  }),
                ),
              )
            }
            if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
              const tool = toolBlocks.get(data.index)
              if (tool) {
                tool.arguments += delta.partial_json
                const item = output[tool.outputIndex]
                if (isObject(item)) item.arguments = tool.arguments
                controller.enqueue(
                  encoder.encode(
                    sse("response.function_call_arguments.delta", {
                      type: "response.function_call_arguments.delta",
                      item_id: tool.id,
                      output_index: tool.outputIndex,
                      delta: delta.partial_json,
                    }),
                  ),
                )
              }
            }
          }

          if (data.type === "content_block_stop" && typeof data.index === "number") {
            const tool = toolBlocks.get(data.index)
            if (tool) {
              const item = output[tool.outputIndex]
              if (isObject(item)) item.status = "completed"
              controller.enqueue(
                encoder.encode(
                  sse("response.function_call_arguments.done", {
                    type: "response.function_call_arguments.done",
                    item_id: tool.id,
                    output_index: tool.outputIndex,
                    arguments: tool.arguments,
                  }),
                ),
              )
              controller.enqueue(encoder.encode(sse("response.output_item.done", { type: "response.output_item.done", output_index: tool.outputIndex, item })))
            } else if (textOutputIndex !== undefined) {
              const item = output[textOutputIndex]
              if (isObject(item)) item.status = "completed"
              controller.enqueue(
                encoder.encode(
                  sse("response.output_text.done", {
                    type: "response.output_text.done",
                    item_id: isObject(item) ? item.id : undefined,
                    output_index: textOutputIndex,
                    content_index: textContentIndex,
                    text,
                  }),
                ),
              )
              controller.enqueue(
                encoder.encode(
                  sse("response.content_part.done", {
                    type: "response.content_part.done",
                    item_id: isObject(item) ? item.id : undefined,
                    output_index: textOutputIndex,
                    content_index: textContentIndex,
                    part: { type: "output_text", text, annotations: [] },
                  }),
                ),
              )
              controller.enqueue(encoder.encode(sse("response.output_item.done", { type: "response.output_item.done", output_index: textOutputIndex, item })))
            }
          }

          if (data.type === "message_delta" && isObject(data.usage)) usage = { ...(usage ?? {}), ...data.usage }
          if (data.type === "message_stop") {
            const inputTokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : undefined
            const outputTokens = typeof usage?.output_tokens === "number" ? usage.output_tokens : undefined
            controller.enqueue(
              encoder.encode(
                sse("response.completed", {
                  type: "response.completed",
                  response: {
                    id: responseID,
                    object: "response",
                    created_at: Math.floor(Date.now() / 1000),
                    status: "completed",
                    model,
                    output,
                    usage: {
                      input_tokens: inputTokens,
                      output_tokens: outputTokens,
                      total_tokens:
                        inputTokens !== undefined || outputTokens !== undefined ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined,
                    },
                  },
                }),
              ),
            )
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            controller.close()
            return
          }
        }
      }

      controller.close()
    },
  })
}
