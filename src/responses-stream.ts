type ObjectValue = Record<string, unknown>
type ItemIdentity = { id?: string; type?: string; done: boolean }

function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

const lifecycle = new Set(["response.created", "response.queued", "response.in_progress", "response.completed", "response.incomplete", "response.failed"])
const itemEvents = new Set(Object.entries({
  output_item: ["added", "done"], content_part: ["added", "done"],
  output_text: ["delta", "done", "annotation.added"], refusal: ["delta", "done"],
  reasoning: ["delta", "done"], reasoning_text: ["delta", "done"],
  reasoning_summary_part: ["added", "done"], reasoning_summary_text: ["delta", "done"],
  function_call_arguments: ["delta", "done"], custom_tool_call_input: ["delta", "done"],
  file_search_call: ["in_progress", "searching", "completed"],
  web_search_call: ["in_progress", "searching", "completed"],
  code_interpreter_call: ["in_progress", "interpreting", "completed", "code.delta", "code.done"],
  image_generation_call: ["in_progress", "generating", "completed", "partial_image"],
  mcp_call: ["in_progress", "completed", "failed", "arguments.delta", "arguments.done"],
  mcp_list_tools: ["in_progress", "completed", "failed"],
}).flatMap(([family, events]) => events.map(event => `response.${family}.${event}`)))

// Keep Responses SSE intact, but use output positions rather than Copilot's rotating IDs.
// In particular, do not rewrite call_id, encrypted_content, or IDs inside annotations.
export function normalizeCopilotResponsesStream(body: ReadableStream<Uint8Array>) {
  const items = new Map<number, ItemIdentity>()
  const aliases = new Map<string, number>()
  let responseID: string | undefined
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
  const encoder = new TextEncoder()
  let fragments: string[] = []
  let pendingCR = false
  let crFrameSize = 0
  let firstLine = true
  let lines: { text: string; ending: string }[] = []
  let frameSize = 0
  const maxFrameSize = 16 * 1024 * 1024

  function responseIdentity(target: ObjectValue, key: string) {
    if (typeof target[key] !== "string" || !target[key]) return
    responseID ??= target[key]
    target[key] = responseID
  }

  function itemIdentity(index: number, type: string | undefined, targets: [ObjectValue, string][], done: boolean) {
    let identity = items.get(index)
    if (!identity) {
      if (items.size >= 4096) throw new Error("Copilot SSE exceeds 4096 output items")
      identity = { type, done: false }
      items.set(index, identity)
    }
    if (type && identity.type && type !== identity.type) throw new Error("Copilot SSE output_index changed item type")
    identity.type ??= type
    for (const [target, key] of targets) {
      const id = target[key]
      if (typeof id !== "string" || !id) continue
      const previous = aliases.get(id)
      if (previous !== undefined && previous !== index) throw new Error("Copilot SSE item ID refers to multiple output positions")
      if (!aliases.has(id) && aliases.size >= 65536) throw new Error("Copilot SSE exceeds 65536 item ID aliases")
      aliases.set(id, index)
      identity.id ??= id
      target[key] = identity.id
    }
    identity.done ||= done
  }

  function normalize(event: ObjectValue) {
    const type = event.type
    if (typeof type !== "string" || (!lifecycle.has(type) && !itemEvents.has(type))) return
    if (lifecycle.has(type) && object(event.response)) {
      responseIdentity(event.response, "id")
      if (Array.isArray(event.response.output)) {
        // The snapshot array includes reasoning and tools, not just messages.
        event.response.output.forEach((item, index) => {
          if (object(item)) itemIdentity(index, typeof item.type === "string" ? item.type : undefined, [[item, "id"]], type !== "response.created" && type !== "response.in_progress" && type !== "response.queued")
        })
      }
    }
    responseIdentity(event, "response_id")
    if (!itemEvents.has(type)) return
    const item = type.startsWith("response.output_item.") && object(event.item) ? event.item : undefined
    const targets: [ObjectValue, string][] = item ? [[item, "id"], [event, "item_id"]] : [[event, "item_id"]]
    const family = type.split(".")[1]
    const itemType = typeof item?.type === "string" ? item.type
      : ["content_part", "output_text", "refusal"].includes(family) ? "message"
      : family.startsWith("reasoning") ? "reasoning"
      : family === "function_call_arguments" ? "function_call"
      : family === "custom_tool_call_input" ? "custom_tool_call"
      : family === "output_item" ? undefined : family
    let index = event.output_index
    if (index !== undefined && (!Number.isSafeInteger(index) || (index as number) < 0)) {
      throw new Error("Copilot SSE has an invalid output_index")
    }
    if (index === undefined) {
      const known = new Set(targets.flatMap(([target, key]) => {
        const id = target[key]
        const found = typeof id === "string" ? aliases.get(id) : undefined
        return found === undefined ? [] : [found]
      }))
      if (known.size === 1) index = [...known][0]
      else if (known.size > 1) throw new Error("Copilot SSE has conflicting item references")
      else if (type !== "response.output_item.added" && itemType) {
        const candidates = [...items].filter(([, identity]) => identity.type === itemType)
        if (candidates.length === 1 && !candidates[0][1].done) index = candidates[0][0]
      }
      // Never guess output order or merge concurrently active items with identical text.
      if (index === undefined) throw new Error("Copilot SSE cannot correlate item without output_index")
    }
    itemIdentity(index as number, itemType, targets, type === "response.output_item.done")
  }

  function frame() {
    const original = lines.map(line => line.text + line.ending).join("")
    const data: number[] = []
    const values: string[] = []
    for (const [index, line] of lines.entries()) {
      const text = line.text.startsWith("\uFEFF") && firstLine && index === 0 ? line.text.slice(1) : line.text
      const colon = text.indexOf(":")
      const field = colon < 0 ? text : text.slice(0, colon)
      if (field !== "data") continue
      data.push(index)
      const value = colon < 0 ? "" : text.slice(colon + 1)
      values.push(value.startsWith(" ") ? value.slice(1) : value)
    }
    const raw = values.join("\n")
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { return original }
    if (!object(parsed)) return original
    const before = JSON.stringify(parsed)
    normalize(parsed)
    const after = JSON.stringify(parsed)
    if (before === after) return original
    // Keep all non-data fields, comments, and line endings; multiline data is one JSON value.
    const first = data[0]
    const rest = new Set(data.slice(1))
    return lines.map((line, index) => index === first ? `${firstLine && index === 0 && line.text.startsWith("\uFEFF") ? "\uFEFF" : ""}data: ${after}${line.ending}` : rest.has(index) ? "" : line.text + line.ending).join("")
  }

  function consume(text: string, controller: TransformStreamDefaultController<Uint8Array>, end = false) {
    const output: string[] = []
    function finishLine(ending: string) {
      const line = fragments.join("")
      fragments = []
      lines.push({ text: line, ending })
      if (line === "") {
        output.push(frame())
        firstLine = false
        lines = []
        frameSize = 0
      }
    }
    let start = 0
    for (let cursor = 0; cursor < text.length; cursor++) {
      const char = text[cursor]
      if (pendingCR) {
        pendingCR = false
        if (char === "\n") {
          if (crFrameSize + 1 > maxFrameSize) throw new Error("Copilot SSE frame exceeds 16 MiB")
          // CR already ended the line. Preserve a following LF without delaying delivery.
          if (lines.length) {
            lines[lines.length - 1].ending += "\n"
            frameSize++
          } else output.push("\n")
          start = cursor + 1
          continue
        }
      }
      frameSize++
      if (frameSize > maxFrameSize) throw new Error("Copilot SSE frame exceeds 16 MiB")
      if (char !== "\r" && char !== "\n") continue
      fragments.push(text.slice(start, cursor))
      if (char === "\r") {
        pendingCR = true
        crFrameSize = frameSize
      }
      finishLine(char)
      start = cursor + 1
    }
    if (start < text.length) fragments.push(text.slice(start))
    if (end && (fragments.length || lines.length)) {
      if (fragments.length) lines.push({ text: fragments.join(""), ending: "" })
      output.push(frame())
      fragments = []
      lines = []
    }
    // One enqueue per input chunk avoids a queue entry per empty SSE frame/keepalive.
    if (output.length) controller.enqueue(encoder.encode(output.join("")))
  }

  // pipeThrough propagates cancellation and transform/upstream errors and releases its reader.
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) { consume(decoder.decode(chunk, { stream: true }), controller) },
    flush(controller) { consume(decoder.decode(), controller, true) },
  }))
}
