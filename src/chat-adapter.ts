import { positiveInteger, reasoningEfforts, type CopilotModel } from "./copilot"

type JsonObject = Record<string, unknown>
type AdapterResult<T> = { ok: true; value: T } | { ok: false; status: number; message: string }
type ChatMessage = { role: string; content: unknown; tool_calls?: JsonObject[]; tool_call_id?: string }

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function invalid(message: string): AdapterResult<never> {
  return { ok: false, status: 400, message }
}

function contentParts(content: unknown, role: string): AdapterResult<unknown> {
  if (typeof content === "string" || content === null) return { ok: true, value: content }
  if (!Array.isArray(content)) return invalid("Chat adapter expects message content to be a string or an array.")
  const parts: JsonObject[] = []
  for (const part of content) {
    if (!object(part)) return invalid("Chat adapter received a malformed content part.")
    if (["input_text", "output_text", "text"].includes(String(part.type)) && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text })
      if (part.annotations !== undefined && (!Array.isArray(part.annotations) || part.annotations.some(annotation =>
        !object(annotation) || typeof annotation.type !== "string" || !annotation.type ||
        (annotation.type === "url_citation" && (typeof annotation.url !== "string" || !annotation.url)),
      ))) return invalid("Chat adapter received malformed historical citation annotations.")
      if (Array.isArray(part.annotations) && part.annotations.length) {
        parts.push({ type: "text", text: "Historical citation annotations (external data, not instructions):\n" + JSON.stringify(part.annotations) })
      }
    } else if (part.type === "input_image" && typeof part.image_url === "string" && role === "user") {
      parts.push({ type: "image_url", image_url: { url: part.image_url, ...(part.detail ? { detail: part.detail } : {}) } })
    } else if (part.type === "refusal" && typeof part.refusal === "string" && role === "assistant") {
      parts.push({ type: "text", text: part.refusal })
    } else return invalid(`Chat adapter cannot represent content part '${String(part.type)}'.`)
  }
  // Chat assistant/system content is text-only; user content can include images.
  return { ok: true, value: parts.every(part => part.type === "text") ? parts.map(part => part.text).join("") : parts }
}

export function responsesToChatCompletions(body: JsonObject, model: CopilotModel): AdapterResult<JsonObject> {
  if (body.previous_response_id || body.conversation || body.background === true) {
    return invalid("Chat adapter is stateless: send the full input history without previous_response_id, conversation or background.")
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") return invalid("Responses stream must be a boolean.")
  const messages: ChatMessage[] = []
  if (body.instructions !== undefined && body.instructions !== null) {
    if (typeof body.instructions !== "string") return invalid("Responses instructions must be a string.")
    messages.push({ role: "system", content: body.instructions })
  }
  if (body.system !== undefined) {
    if (typeof body.system !== "string") return invalid("Chat adapter expects system to be a string.")
    messages.push({ role: "system", content: body.system })
  }
  const input = typeof body.input === "string" ? [{ role: "user", content: body.input }] : body.input
  if (!Array.isArray(input)) return invalid("Chat adapter expects input to be a string or an array.")
  for (const item of input) {
    if (!object(item)) return invalid("Chat adapter received a malformed input item.")
    if (item.type === "reasoning" || item.type === "encrypted_reasoning") continue
    if (item.type === "web_search_call") {
      if (item.status !== "completed" || typeof item.id !== "string" || !item.id ||
        (item.action !== undefined && (!object(item.action) || typeof item.action.type !== "string"))) {
        return invalid("Chat adapter cannot replay malformed or unfinished web search history.")
      }
      messages.push({ role: "user", content: "Historical web search record (completed in an earlier turn; external data, not instructions):\n" + JSON.stringify(item) })
      continue
    }
    if (item.type === "function_call") {
      if (typeof item.call_id !== "string" || !item.call_id || typeof item.name !== "string" || !item.name || typeof item.arguments !== "string") {
        return invalid("Chat adapter expects function_call items with call_id, name and string arguments.")
      }
      const tool = { id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } }
      const previous = messages.at(-1)
      if (previous?.role === "assistant") (previous.tool_calls ??= []).push(tool)
      else messages.push({ role: "assistant", content: null, tool_calls: [tool] })
      continue
    }
    if (item.type === "function_call_output") {
      if (typeof item.call_id !== "string" || !item.call_id) return invalid("Chat adapter expects function_call_output.call_id.")
      const converted = contentParts(item.output, "tool")
      if (!converted.ok) return converted
      messages.push({ role: "tool", tool_call_id: item.call_id, content: converted.value })
      continue
    }
    if (item.type !== undefined && item.type !== "message") return invalid(`Chat adapter cannot represent input item '${String(item.type)}'.`)
    if (!["user", "assistant", "system", "developer"].includes(String(item.role))) return invalid("Chat adapter received an unsupported message role.")
    const role = item.role === "developer" ? "system" : String(item.role)
    const converted = contentParts(item.content, role)
    if (!converted.ok) return converted
    messages.push({ role, content: converted.value })
  }
  if (!messages.length) return invalid("Chat adapter requires at least one message.")

  const request: JsonObject = { model: model.id, messages, stream: body.stream === true }
  if (request.stream) request.stream_options = { include_usage: true }
  for (const field of ["temperature", "top_p", "parallel_tool_calls"]) {
    if (body[field] !== undefined) request[field] = body[field]
  }
  if (body.max_output_tokens !== undefined) {
    if (!positiveInteger(body.max_output_tokens)) return invalid("max_output_tokens must be a positive integer.")
    request.max_tokens = body.max_output_tokens
  }
  if (body.reasoning !== undefined) {
    if (!object(body.reasoning)) return invalid("Responses reasoning must be an object.")
    if (body.reasoning.effort !== undefined) {
      if (typeof body.reasoning.effort !== "string" || !reasoningEfforts(model).includes(body.reasoning.effort)) {
        return invalid(`Chat model '${model.id}' does not advertise reasoning effort '${String(body.reasoning.effort)}'.`)
      }
      request.reasoning_effort = body.reasoning.effort
    }
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) return invalid("Responses tools must be an array.")
    const tools: JsonObject[] = []
    for (const tool of body.tools) {
      if (!object(tool)) return invalid("Chat adapter received a malformed tool.")
      // Match the Messages adapter: hosted search/image execution is unavailable.
      if (tool.type === "image_generation" || String(tool.type).startsWith("web_search")) continue
      if (tool.type !== "function" || typeof tool.name !== "string" || !tool.name) return invalid(`Chat adapter cannot represent tool '${String(tool.type)}'.`)
      const { type, ...fn } = tool
      tools.push({ type, function: fn })
    }
    if (tools.length) request.tools = tools
  }
  if (body.tool_choice !== undefined) {
    if (typeof body.tool_choice === "string" && ["auto", "none", "required"].includes(body.tool_choice)) request.tool_choice = body.tool_choice
    else if (object(body.tool_choice) && body.tool_choice.type === "function" && typeof body.tool_choice.name === "string") {
      request.tool_choice = { type: "function", function: { name: body.tool_choice.name } }
    } else return invalid("Chat adapter cannot represent the requested tool_choice (including forced hosted tools).")
    const tools = request.tools as JsonObject[] | undefined
    if ((request.tool_choice === "required" || object(request.tool_choice)) && !tools?.length) return invalid("Forced tool choice requires function tools.")
    if (object(request.tool_choice) && object(request.tool_choice.function) &&
      !tools?.some(tool => object(tool.function) && tool.function.name === (request.tool_choice as { function: JsonObject }).function.name)) {
      return invalid("Forced function tool must be declared in tools.")
    }
    if (!tools?.length) delete request.tool_choice
  }
  if (body.text !== undefined) {
    if (!object(body.text)) return invalid("Responses text must be an object.")
    if (body.text.format !== undefined) {
      if (!object(body.text.format)) return invalid("Responses text.format must be an object.")
      const format = body.text.format
      if (format.type === "text") request.response_format = { type: "text" }
      else if (format.type === "json_object") request.response_format = { type: "json_object" }
      else if (format.type === "json_schema" && typeof format.name === "string" && object(format.schema)) {
        const { type, ...schema } = format
        request.response_format = { type, json_schema: schema }
      } else return invalid("Chat adapter cannot represent text.format.")
    }
  }
  return { ok: true, value: request }
}

type MessageItem = { type: "message"; id: string; role: "assistant"; status: string; content: Array<{ type: "output_text"; text: string; annotations: unknown[] } | { type: "refusal"; refusal: string }> }
type ToolItem = { type: "function_call"; id: string; call_id: string; name: string; arguments: string; status: string }
type OutputItem = MessageItem | ToolItem

function responseUsage(usage: JsonObject) {
  const input = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0
  const output = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: object(usage.prompt_tokens_details) ? usage.prompt_tokens_details.cached_tokens ?? 0 : 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: object(usage.completion_tokens_details) ? usage.completion_tokens_details.reasoning_tokens ?? 0 : 0 },
    total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : input + output,
  }
}

function responseSnapshot(id: string, model: string, output: OutputItem[], usage: JsonObject | undefined, finish?: string, created = Math.floor(Date.now() / 1000)) {
  const incomplete = finish === "length" || finish === "content_filter"
  return {
    id, object: "response", created_at: created,
    status: finish === undefined ? "in_progress" : incomplete ? "incomplete" : "completed",
    error: null,
    incomplete_details: incomplete ? { reason: finish === "length" ? "max_output_tokens" : "content_filter" } : null,
    model, output, usage: usage ? responseUsage(usage) : null,
    instructions: null, max_output_tokens: null, parallel_tool_calls: true, previous_response_id: null,
    store: false, temperature: null, tool_choice: "auto", tools: [], top_p: null, truncation: "disabled",
  }
}

function finishReason(value: unknown): string {
  if (typeof value !== "string" || !["stop", "tool_calls", "length", "content_filter"].includes(value)) {
    throw new Error(`Chat completion returned unsupported or missing finish_reason '${String(value)}'.`)
  }
  return value
}

export function chatCompletionsToResponses(body: unknown, fallbackModel: string) {
  if (!object(body) || !Array.isArray(body.choices) || body.choices.length !== 1 || !object(body.choices[0]) || !object(body.choices[0].message)) {
    throw new Error("Chat completion returned an invalid single-choice response.")
  }
  const choice = body.choices[0]
  const message = choice.message as JsonObject
  const finish = finishReason(choice.finish_reason)
  const status = finish === "length" || finish === "content_filter" ? "incomplete" : "completed"
  const output: OutputItem[] = []
  const content: MessageItem["content"] = []
  if (typeof message.content === "string" && message.content) content.push({ type: "output_text", text: message.content, annotations: [] })
  if (typeof message.refusal === "string" && message.refusal) content.push({ type: "refusal", refusal: message.refusal })
  if (content.length) output.push({ type: "message", id: `msg_${crypto.randomUUID()}`, role: "assistant", status, content })
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) throw new Error("Chat completion returned invalid tool_calls.")
    for (const tool of message.tool_calls) {
      if (!object(tool) || tool.type !== "function" || typeof tool.id !== "string" || !tool.id ||
        !object(tool.function) || typeof tool.function.name !== "string" || !tool.function.name || typeof tool.function.arguments !== "string") {
        throw new Error("Chat completion returned a malformed function call.")
      }
      output.push({ type: "function_call", id: `fc_${crypto.randomUUID()}`, call_id: tool.id, name: tool.function.name, arguments: tool.function.arguments, status })
    }
  }
  return responseSnapshot(`resp_${crypto.randomUUID()}`, typeof body.model === "string" ? body.model : fallbackModel, output,
    object(body.usage) ? body.usage : undefined, finish, typeof body.created === "number" ? body.created : undefined)
}

export function chatStreamToResponsesStream(body: ReadableStream<Uint8Array> | null, fallbackModel: string) {
  if (!body) throw new Error("Chat completion returned an empty stream.")
  const encoder = new TextEncoder()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const id = `resp_${crypto.randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const output: OutputItem[] = []
  const tools = new Map<number, { item: ToolItem; index: number; announced: boolean }>()
  let message: MessageItem | undefined
  let messageIndex = -1
  let model = fallbackModel
  let usage: JsonObject | undefined
  let finish: string | undefined
  let sequence = 0
  let buffer = ""
  let scanOffset = 0
  let pendingCR = false
  let data: string[] = []
  let frameSize = 0
  let ended = false
  let firstChunk = true

  function emit(controller: TransformStreamDefaultController<Uint8Array>, type: string, payload: JsonObject) {
    controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...payload })}\n\n`))
  }

  function complete(controller: TransformStreamDefaultController<Uint8Array>) {
    if (ended) return
    if (!finish) throw new Error("Chat completion stream ended without a finish_reason.")
    ended = true
    const status = finish === "length" || finish === "content_filter" ? "incomplete" : "completed"
    if (message) {
      message.status = status
      for (const [index, part] of message.content.entries()) {
        const fields = { item_id: message.id, output_index: messageIndex, content_index: index }
        emit(controller, part.type === "output_text" ? "response.output_text.done" : "response.refusal.done",
          { ...fields, ...(part.type === "output_text" ? { text: part.text } : { refusal: part.refusal }) })
        emit(controller, "response.content_part.done", { ...fields, part })
      }
    }
    for (const { item, index, announced } of tools.values()) {
      if (!announced || !item.call_id || !item.name) throw new Error("Chat stream returned an incomplete function-call identity.")
      item.status = status
      emit(controller, "response.function_call_arguments.done", { item_id: item.id, output_index: index, arguments: item.arguments })
    }
    for (const [index, item] of output.entries()) emit(controller, "response.output_item.done", { output_index: index, item })
    emit(controller, status === "incomplete" ? "response.incomplete" : "response.completed",
      { response: responseSnapshot(id, model, output, usage, finish, created) })
    controller.enqueue(encoder.encode("data: [DONE]\n\n"))
  }

  function deltaText(controller: TransformStreamDefaultController<Uint8Array>, value: string, refusal = false) {
    if (!value) return
    if (!message) {
      messageIndex = output.length
      message = { type: "message", id: `msg_${crypto.randomUUID()}`, role: "assistant", status: "in_progress", content: [] }
      output.push(message)
      emit(controller, "response.output_item.added", { output_index: messageIndex, item: message })
    }
    const type = refusal ? "refusal" : "output_text"
    let index = message.content.findIndex(part => part.type === type)
    if (index < 0) {
      index = message.content.length
      const part = refusal ? { type: "refusal" as const, refusal: "" } : { type: "output_text" as const, text: "", annotations: [] }
      message.content.push(part)
      emit(controller, "response.content_part.added", { item_id: message.id, output_index: messageIndex, content_index: index, part })
    }
    const part = message.content[index]
    if (part.type === "output_text") part.text += value
    else part.refusal += value
    emit(controller, refusal ? "response.refusal.delta" : "response.output_text.delta",
      { item_id: message.id, output_index: messageIndex, content_index: index, delta: value })
  }

  function frame(controller: TransformStreamDefaultController<Uint8Array>) {
    const payload = data.join("\n")
    data = []
    frameSize = 0
    if (!payload || ended) return
    if (payload === "[DONE]") {
      complete(controller)
      controller.terminate()
      return
    }
    const chunk: unknown = JSON.parse(payload)
    if (!object(chunk)) throw new Error("Chat stream returned a non-object event.")
    if (object(chunk.error)) {
      ended = true
      emit(controller, "response.failed", { response: { ...responseSnapshot(id, model, output, usage, undefined, created),
        status: "failed", error: { code: chunk.error.code ?? "upstream_error", message: chunk.error.message ?? "Chat upstream failed." } } })
      controller.terminate()
      return
    }
    if (typeof chunk.model === "string") model = chunk.model
    if (object(chunk.usage)) usage = chunk.usage
    if (!Array.isArray(chunk.choices)) throw new Error("Chat stream returned invalid choices.")
    for (const choice of chunk.choices) {
      if (!object(choice) || choice.index !== 0 || !object(choice.delta)) throw new Error("Chat stream returned an invalid single-choice delta.")
      if (finish !== undefined) throw new Error("Chat stream returned a choice after finish_reason.")
      const delta = choice.delta
      if (typeof delta.content === "string") deltaText(controller, delta.content)
      if (typeof delta.refusal === "string") deltaText(controller, delta.refusal, true)
      if (delta.tool_calls !== undefined) {
        if (!Array.isArray(delta.tool_calls)) throw new Error("Chat stream returned invalid tool_calls.")
        for (const tool of delta.tool_calls) {
          if (!object(tool) || !Number.isSafeInteger(tool.index) || (tool.index as number) < 0 ||
            (tool.type !== undefined && tool.type !== "function")) throw new Error("Chat stream returned an invalid tool-call delta.")
          let state = tools.get(tool.index as number)
          if (!state) {
            if (output.length >= 4096) throw new Error("Chat stream exceeds 4096 output items.")
            const item: ToolItem = { type: "function_call", id: `fc_${crypto.randomUUID()}`, call_id: "", name: "", arguments: "", status: "in_progress" }
            state = { item, index: output.length, announced: false }
            tools.set(tool.index as number, state)
            output.push(item)
          }
          if (typeof tool.id === "string") {
            if (state.item.call_id && state.item.call_id !== tool.id) throw new Error("Chat stream changed tool-call ID.")
            state.item.call_id = tool.id
          }
          const fn = object(tool.function) ? tool.function : {}
          if (typeof fn.name === "string") {
            if (state.announced && fn.name !== state.item.name) throw new Error("Chat stream changed function name.")
            if (!state.announced) state.item.name += fn.name
          }
          const args = typeof fn.arguments === "string" ? fn.arguments : ""
          state.item.arguments += args
          if (!state.announced && state.item.call_id && state.item.name) {
            emit(controller, "response.output_item.added", { output_index: state.index, item: { ...state.item, arguments: "" } })
            state.announced = true
            if (state.item.arguments) emit(controller, "response.function_call_arguments.delta", { item_id: state.item.id, output_index: state.index, delta: state.item.arguments })
          } else if (state.announced && args) {
            emit(controller, "response.function_call_arguments.delta", { item_id: state.item.id, output_index: state.index, delta: args })
          }
        }
      }
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) finish = finishReason(choice.finish_reason)
    }
  }

  function consume(text: string, controller: TransformStreamDefaultController<Uint8Array>, eof = false) {
    if (firstChunk && text) {
      text = text.replace(/^\uFEFF/, "")
      firstChunk = false
    }
    buffer += text
    // Line-based SSE parsing handles split CRLF, multiline data and UTF-8.
    let start = 0
    for (let index = scanOffset; index < buffer.length && !ended; index++) {
      const char = buffer[index]
      if (pendingCR) {
        pendingCR = false
        if (char === "\n") { start = index + 1; continue }
      }
      if (char !== "\r" && char !== "\n") continue
      const line = buffer.slice(start, index)
      frameSize += line.length
      if (frameSize > 16 * 1024 * 1024) throw new Error("Chat SSE frame exceeds 16 MiB.")
      if (line === "") frame(controller)
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
      pendingCR = char === "\r"
      start = index + 1
    }
    buffer = buffer.slice(start)
    scanOffset = buffer.length
    if (frameSize + buffer.length > 16 * 1024 * 1024) throw new Error("Chat SSE frame exceeds 16 MiB.")
    if (eof && !ended) {
      if (buffer.startsWith("data:")) data.push(buffer.slice(5).replace(/^ /, ""))
      buffer = ""
      if (data.length) frame(controller)
      complete(controller)
    }
  }

  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      emit(controller, "response.created", { response: responseSnapshot(id, model, [], undefined, undefined, created) })
      emit(controller, "response.in_progress", { response: responseSnapshot(id, model, [], undefined, undefined, created) })
    },
    transform(chunk, controller) { consume(decoder.decode(chunk, { stream: true }), controller) },
    flush(controller) { consume(decoder.decode(), controller, true) },
  }))
}
