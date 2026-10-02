import { describe, expect, test } from "bun:test"
import { chatCompletionsToResponses, chatStreamToResponsesStream, responsesToChatCompletions } from "../src/chat-adapter"
import { buildCodexModels, clearCopilotModelsCache } from "../src/copilot"
import { createHandler } from "../src/server"

const metadata = { id: "gemini-test", model_picker_enabled: true, supported_endpoints: ["/chat/completions"],
  capabilities: { supports: { tool_calls: true, vision: true, reasoning_effort: ["low", "high"] } } }
const tools = [{ type: "function", name: "lookup", parameters: { type: "object", properties: { city: { type: "string" } } }, strict: true }]
type ResponseBody = ReturnType<typeof chatCompletionsToResponses>
type StreamEvent = {
  type: string; sequence_number: number; response: ResponseBody; output_index: number;
  item: ResponseBody["output"][number]; item_id: string; delta: string;
}

function successfulRequest(body: Record<string, unknown>) {
  const result = responsesToChatCompletions({ model: metadata.id, input: "hello", ...body }, metadata)
  if (!result.ok) throw new Error(result.message)
  return result.value
}

function chunk(delta: unknown, finish: string | null = null) {
  return { id: "chatcmpl-test", model: metadata.id, choices: [{ index: 0, delta, finish_reason: finish }] }
}

function upstreamStream(events: unknown[], ending = "\n", fragment = false) {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${event === "[DONE]" ? event : JSON.stringify(event)}${ending}${ending}`).join(""))
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return }
      const end = fragment ? offset + 1 : bytes.length
      controller.enqueue(bytes.slice(offset, end))
      offset = end
    },
  })
}

async function convertedEvents(body: ReadableStream<Uint8Array>) {
  const text = await new Response(chatStreamToResponsesStream(body, metadata.id)).text()
  return text.split("\n\n").flatMap(frame => {
    const data = frame.split("\n").find(line => line.startsWith("data: "))?.slice(6)
    return data && data !== "[DONE]" ? [JSON.parse(data) as StreamEvent] : []
  })
}

describe("Responses to Chat Completions", () => {
  test("maps instructions, tools, output limits, reasoning and structured output without mutating the request", () => {
    const body = { input: "hello", instructions: "be concise", stream: true, tools,
      tool_choice: { type: "function", name: "lookup" }, max_output_tokens: 100, temperature: 0.2, top_p: 0.9,
      parallel_tool_calls: false, reasoning: { effort: "low" },
      text: { format: { type: "json_schema", name: "result", schema: { type: "object" }, strict: true } } }
    const copy = structuredClone(body)
    expect(successfulRequest(body)).toEqual({
      model: metadata.id, messages: [{ role: "system", content: "be concise" }, { role: "user", content: "hello" }],
      stream: true, stream_options: { include_usage: true }, max_tokens: 100, temperature: 0.2, top_p: 0.9,
      parallel_tool_calls: false, reasoning_effort: "low",
      tools: [{ type: "function", function: { name: "lookup", parameters: tools[0].parameters, strict: true } }],
      tool_choice: { type: "function", function: { name: "lookup" } },
      response_format: { type: "json_schema", json_schema: { name: "result", schema: { type: "object" }, strict: true } },
    })
    expect(body).toEqual(copy)
  })

  test("preserves images, developer instructions, assistant text and parallel function-call history", () => {
    const input = [
      { role: "developer", content: [{ type: "input_text", text: "instruction" }] },
      { role: "user", content: [{ type: "input_text", text: "inspect" }, { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "low" }] },
      { type: "reasoning", encrypted_content: "opaque" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "checking" }] },
      ...["a", "b"].map(call_id => ({ type: "function_call", id: `fc_${call_id}`, call_id, name: "lookup", arguments: "{}" })),
      { type: "function_call_output", call_id: "a", output: "result a" },
      { type: "function_call_output", call_id: "b", output: [{ type: "input_text", text: "result b" }] },
    ]
    const original = structuredClone(input)
    expect(successfulRequest({ input }).messages).toEqual([
      { role: "system", content: "instruction" },
      { role: "user", content: [{ type: "text", text: "inspect" }, { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=", detail: "low" } }] },
      { role: "assistant", content: "checking", tool_calls: ["a", "b"].map(id => ({ id, type: "function", function: { name: "lookup", arguments: "{}" } })) },
      { role: "tool", tool_call_id: "a", content: "result a" },
      { role: "tool", tool_call_id: "b", content: "result b" },
    ])
    expect(input).toEqual(original)
  })

  test("filters hosted declarations but retains labeled completed search and citation history", () => {
    const result = successfulRequest({ tools: [{ type: "web_search" }, { type: "image_generation" }, ...tools], input: [
      { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "reference" } },
      { role: "assistant", content: [{ type: "output_text", text: "source", annotations: [{ type: "url_citation", url: "https://example.test" }] }] },
      { role: "user", content: "continue" },
    ] })
    expect(result.tools).toHaveLength(1)
    expect(JSON.stringify(result.messages)).toContain("Historical web search record")
    expect(JSON.stringify(result.messages)).toContain("Historical citation annotations")
  })

  test.each([
    { previous_response_id: "resp_1" }, { conversation: "conv_1" }, { background: true }, { stream: "true" },
    { input: [] }, { input: [{ type: "input_file" }] }, { input: [{ role: "user", content: [{ type: "input_audio" }] }] },
    { input: [{ type: "function_call", call_id: "a", name: "lookup", arguments: {} }] },
    { input: [{ type: "function_call_output", output: "missing id" }] },
    { input: [{ type: "web_search_call", id: "ws", status: "in_progress" }] },
    { input: [{ role: "assistant", content: [{ type: "output_text", text: "source", annotations: { url: "https://example.test" } }] }] },
    { reasoning: { effort: "max" } }, { max_output_tokens: 0 }, { tools: [{ type: "code_interpreter" }] },
    { tool_choice: { type: "web_search" } }, { tool_choice: "required", tools: [{ type: "web_search" }] },
    { tools, tool_choice: { type: "function", name: "undeclared" } },
    { text: { format: { type: "unsupported" } } },
  ])("rejects unsupported or malformed requests: %j", body => {
    expect(responsesToChatCompletions({ model: metadata.id, input: "hello", ...body }, metadata)).toMatchObject({ ok: false, status: 400 })
  })
})

describe("Chat completion response mapping", () => {
  test("maps assistant text, refusal, tool calls, usage and stable function call IDs", () => {
    const response = chatCompletionsToResponses({ model: metadata.id, created: 123, choices: [{
      finish_reason: "tool_calls", message: { content: "checking", refusal: "restricted",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
    }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 2 },
      completion_tokens_details: { reasoning_tokens: 1 } } }, metadata.id)
    expect(response).toMatchObject({ object: "response", status: "completed", created_at: 123, model: metadata.id,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } } })
    expect(response.id).toStartWith("resp_")
    expect(response.output).toEqual([
      { type: "message", id: expect.stringMatching(/^msg_/), role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "checking", annotations: [] }, { type: "refusal", refusal: "restricted" }] },
      { type: "function_call", id: expect.stringMatching(/^fc_/), call_id: "call_1", name: "lookup", arguments: "{}", status: "completed" },
    ])
  })

  test.each(["length", "content_filter"])("marks %s as incomplete rather than successful", finish_reason => {
    expect(chatCompletionsToResponses({ choices: [{ finish_reason, message: { content: "partial" } }] }, metadata.id)).toMatchObject({
      status: "incomplete", incomplete_details: { reason: finish_reason === "length" ? "max_output_tokens" : "content_filter" },
      output: [{ status: "incomplete" }], usage: null,
    })
  })

  test.each([{}, { choices: [] }, { choices: [{ message: {}, finish_reason: null }] },
    { choices: [{ message: { tool_calls: [{}] }, finish_reason: "tool_calls" }] }])("rejects malformed upstream JSON: %j", body => {
    expect(() => chatCompletionsToResponses(body, metadata.id)).toThrow()
  })
})

describe("Chat SSE mapping", () => {
  test.each(["\n", "\r\n", "\r"])("handles byte-fragmented %j framing, Unicode, parallel tools and usage", async ending => {
    const events = await convertedEvents(upstreamStream([
      chunk({ role: "assistant", content: "\u4f60\u597d" }),
      chunk({ tool_calls: [
        { index: 0, id: "call_a", type: "function", function: { name: "lookup", arguments: '{"city":' } },
        { index: 1, id: "call_b", type: "function", function: { name: "lookup", arguments: "{}" } },
      ] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"\u6b66\u6c49"}' } }] }),
      chunk({}, "tool_calls"),
      { choices: [], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } },
      "[DONE]",
    ], ending, true))
    expect(events.map(event => event.sequence_number)).toEqual(events.map((_, index) => index))
    const final = events.at(-1)!
    expect(final.type).toBe("response.completed")
    expect(final.response.output).toMatchObject([
      { type: "message", content: [{ text: "\u4f60\u597d" }] },
      { type: "function_call", call_id: "call_a", name: "lookup", arguments: '{"city":"\u6b66\u6c49"}' },
      { type: "function_call", call_id: "call_b", name: "lookup", arguments: "{}" },
    ])
    expect(final.response.usage).toMatchObject({ input_tokens: 8, output_tokens: 4, total_tokens: 12 })
    const added = events.filter(event => event.type === "response.output_item.added")
    const done = events.filter(event => event.type === "response.output_item.done")
    expect(done.map(event => event.item.id)).toEqual(added.map(event => event.item.id))
    expect(final.response.output.map(item => item.id)).toEqual(added.map(event => event.item.id))
    for (const event of events.filter(event => event.item_id)) expect(event.item_id).toBe(added[event.output_index].item.id)
  })

  test("buffers arguments before tool identity and emits them exactly once", async () => {
    const events = await convertedEvents(upstreamStream([
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] }),
      chunk({ tool_calls: [{ index: 0, id: "call_late", function: { name: "lookup", arguments: "1}" } }] }),
      chunk({}, "tool_calls"), "[DONE]",
    ]))
    expect(events.filter(event => event.type === "response.function_call_arguments.delta").map(event => event.delta).join("")).toBe('{"a":1}')
    expect(events.at(-1)!.response.output[0]).toMatchObject({ call_id: "call_late", arguments: '{"a":1}' })
  })

  test("supports multiline SSE, BOM, heartbeat, refusal and a final frame without delimiter", async () => {
    const body = new Response("\uFEFF: heartbeat\r\ndata: " + JSON.stringify(chunk({ refusal: "no" })) + "\r\n\r\n" +
      'data: {"choices":\r\ndata: [{"index":0,"delta":{},"finish_reason":"stop"}]}').body!
    const events = await convertedEvents(body)
    expect(events.some(event => event.type === "response.refusal.delta" && event.delta === "no")).toBe(true)
    expect(events.at(-1)!.response.output[0]).toMatchObject({ content: [{ type: "refusal", refusal: "no" }] })
  })

  test("maps token-limit termination to response.incomplete", async () => {
    const events = await convertedEvents(upstreamStream([chunk({ content: "partial" }), chunk({}, "length"), "[DONE]"]))
    expect(events.at(-1)).toMatchObject({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } })
    expect(events.some(event => event.type === "response.completed")).toBe(false)
  })

  test("reports upstream error events without a completed response", async () => {
    const events = await convertedEvents(upstreamStream([chunk({ content: "partial" }), { error: { code: "rate_limit", message: "retry later" } }]))
    expect(events.at(-1)).toMatchObject({ type: "response.failed", response: { status: "failed", error: { code: "rate_limit", message: "retry later" } } })
    expect(events.some(event => event.type === "response.completed")).toBe(false)
  })

  test.each([
    [chunk({ content: "truncated" })],
    [chunk({}), "[DONE]"],
    [chunk({ tool_calls: [{ index: 0, function: { arguments: "{}" } }] }), chunk({}, "tool_calls"), "[DONE]"],
    [chunk({ tool_calls: [{ index: -1 }] })],
    [{ choices: [{ index: 1, delta: {} }] }],
  ])("fails truncated or malformed streams", async (...events) => {
    await expect(convertedEvents(upstreamStream(events))).rejects.toThrow()
  })

  test("invalid UTF-8/JSON and upstream errors propagate and cancel the reader", async () => {
    for (const bytes of [new Uint8Array([0xff]), new TextEncoder().encode("data: invalid\n\n")]) {
      let cancelled = false
      const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes) }, cancel() { cancelled = true } })
      await expect(convertedEvents(body)).rejects.toThrow()
      await Bun.sleep(0)
      expect(cancelled).toBe(true)
      expect(body.locked).toBe(false)
    }
    const error = new Error("upstream disconnected")
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(error) } })
    await expect(convertedEvents(body)).rejects.toBe(error)
    expect(body.locked).toBe(false)
  })

  test("rejects oversized frames and releases the upstream reader", async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("data: " + "x".repeat(16 * 1024 * 1024))) },
      cancel() { cancelled = true },
    })
    await expect(convertedEvents(body)).rejects.toThrow("Chat SSE frame exceeds 16 MiB")
    await Bun.sleep(0)
    expect(cancelled).toBe(true)
    expect(body.locked).toBe(false)
  })

  test("DONE finishes the response without waiting for upstream EOF", async () => {
    let cancelled = false
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify(chunk({ content: "done" }, "stop"))}\n\ndata: [DONE]\n\n`)
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes) },
      cancel() { cancelled = true },
    })
    const events = await convertedEvents(body)
    expect(events.at(-1)!.type).toBe("response.completed")
    await Bun.sleep(0)
    expect(cancelled).toBe(true)
    expect(body.locked).toBe(false)
  })

  test("bare-CR frames deliver deltas immediately while upstream remains open", async () => {
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify(chunk({ content: "early" }))}\r\r`)
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes) } })
    const reader = chatStreamToResponsesStream(body, metadata.id).getReader()
    try {
      let seen = ""
      for (let index = 0; index < 5; index++) {
        const next = await Promise.race([
          reader.read(),
          Bun.sleep(1000).then(() => { throw new Error("CR frame was not delivered before EOF") }),
        ])
        seen += new TextDecoder().decode(next.value)
      }
      expect(seen).toContain("response.output_text.delta")
      expect(seen).toContain('"delta":"early"')
    } finally {
      await reader.cancel()
    }
  })

  test("emits deltas before completion and forwards cancellation with bounded prefetch", async () => {
    let pulls = 0
    let cancelled: unknown
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk({ content: "part" }))}\n\n`)) },
      cancel(reason) { cancelled = reason },
    })
    const reader = chatStreamToResponsesStream(body, metadata.id).getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("response.created")
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("response.in_progress")
    const delta = new TextDecoder().decode((await reader.read()).value)
    expect(delta).toContain("response.output_item.added")
    for (let index = 0; index < 2; index++) await reader.read()
    await Bun.sleep(10)
    expect(pulls).toBeLessThanOrEqual(3)
    await reader.cancel("client left")
    await Bun.sleep(0)
    expect(cancelled).toBe("client left")
    expect(body.locked).toBe(false)
  })
})

test("HTTP Gemini discovery, streaming and non-streaming tool continuation round trip", async () => {
  clearCopilotModelsCache()
  const received: Record<string, unknown>[] = []
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/models") return Response.json({ data: [metadata] })
    expect(url.pathname).toBe("/chat/completions")
    const body = await request.json()
    received.push(body)
    if (body.stream) {
      expect(body.stream_options).toEqual({ include_usage: true })
      return new Response(upstreamStream([
        chunk({ tool_calls: [{ index: 0, id: "call_http", type: "function", function: { name: "lookup", arguments: "{}" } }] }),
        chunk({}, "tool_calls"), "[DONE]",
      ]), { headers: { "content-type": "text/event-stream", "etag": "stale", "content-md5": "stale" } })
    }
    return Response.json({ choices: [{ message: { content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 1 } })
  } })
  const bridge = Bun.serve({ port: 0, hostname: "127.0.0.1",
    fetch: createHandler(upstream.url.origin, fetch, undefined, async available => buildCodexModels(available)) })
  try {
    const models = await fetch(new URL("/v1/models", bridge.url)).then(response => response.json())
    expect(models.data[0]).toMatchObject({ id: metadata.id, supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] })
    const send = (body: unknown) => fetch(new URL("/v1/responses", bridge.url), { method: "POST", body: JSON.stringify(body) })
    const first = await send({ model: metadata.id, input: "lookup", tools, stream: true })
    expect(first.status).toBe(200)
    expect(first.headers.get("etag")).toBeNull()
    expect(first.headers.get("content-md5")).toBeNull()
    const raw = await first.text()
    const final = JSON.parse(raw.split("\n").find(line => line.startsWith("data: ") && line.includes('"type":"response.completed"'))!.slice(6)).response as ResponseBody
    const response = await send({ model: metadata.id, tools, input: [
      ...final.output, { type: "function_call_output", call_id: "call_http", output: "contents" },
    ] })
    expect(response.status).toBe(200)
    expect((await response.json()).output[0].content[0].text).toBe("done")
    expect(received[1].messages).toEqual([
      { role: "assistant", content: null, tool_calls: [{ id: "call_http", type: "function", function: { name: "lookup", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_http", content: "contents" },
    ])
    const rejected = await send({ model: metadata.id, input: "hello", previous_response_id: "resp_old" })
    expect(rejected.status).toBe(400)
    expect((await rejected.json()).error.code).toBe("chat_adapter_error")
    expect(received).toHaveLength(2)
  } finally {
    bridge.stop(true)
    upstream.stop(true)
    clearCopilotModelsCache()
  }
})

test("HTTP adapter passes upstream HTTP errors through and rejects malformed successful payloads", async () => {
  for (const streaming of [false, true]) {
    const handler = createHandler("https://copilot.example.test", async () =>
      new Response('{"error":{"message":"rate limited"}}', { status: 429, headers: { "retry-after": "5", "content-type": "application/json" } }),
    async () => [metadata])
    const response = await handler(new Request("http://localhost/v1/responses", {
      method: "POST", body: JSON.stringify({ model: metadata.id, input: "hello", stream: streaming }),
    }))
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("5")
    expect((await response.json()).error.message).toBe("rate limited")
  }
  for (const stream of [false, true]) {
    const handler = createHandler("https://copilot.example.test", async () => Response.json({ invalid: true }), async () => [metadata])
    const response = await handler(new Request("http://localhost/v1/responses", {
      method: "POST", body: JSON.stringify({ model: metadata.id, input: "hello", stream }),
    }))
    expect(response.status).toBe(502)
    expect((await response.json()).error.code).toBe("chat_adapter_error")
  }
})
