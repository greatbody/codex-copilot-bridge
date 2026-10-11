import { expect, test } from "bun:test"
import { adaptGrokTools } from "../src/grok-tools"
import { normalizeCopilotResponsesStream } from "../src/responses-stream"
import { createHandler } from "../src/server"

const patch = "*** Begin Patch\n*** Add File: hello.txt\n+Hello\n*** End Patch\n"
const tools = [
  { type: "function", name: "files__read", parameters: { type: "object" } },
  { type: "namespace", name: "files", description: "File tools", tools: [
    { type: "function", name: "read", description: "Read", parameters: { type: "object" } },
    { type: "custom", name: "patch", description: "Patch", format: { type: "text" } },
  ] },
  { type: "custom", name: "apply_patch", description: "Apply patch",
    format: { type: "grammar", syntax: "lark", definition: "start: \"patch\"" } },
  { type: "web_search" },
]

test("Grok flattens namespaces without name collisions and wraps custom tools without mutating input", () => {
  const body = { model: "grok-4.7", input: "hello", tools }
  const before = structuredClone(body)
  const adapter = adaptGrokTools(body)
  const converted = adapter.request.tools as Record<string, unknown>[]
  expect(converted).toHaveLength(4)
  expect(converted.every(t => t.type === "function")).toBe(true)
  expect(converted[0].name).toBe("files__read")
  expect(converted[1].name).not.toBe("files__read")
  expect(new Set(converted.map(t => t.name)).size).toBe(4)
  expect(converted[1].description).toBe("File tools\nRead")
  expect(converted[3]).toMatchObject({ name: "apply_patch", strict: true,
    parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false } })
  expect(converted[3].description).toContain("Input grammar:")
  expect(body).toEqual(before)
  expect(adapter.response({ id: "r", output: [
    { type: "function_call", name: converted[1].name, arguments: "{}", call_id: "call_read" },
    { type: "function_call", name: converted[2].name, arguments: JSON.stringify({ input: patch }), call_id: "call_patch" },
  ] })).toEqual({ id: "r", output: [
    { type: "function_call", name: "read", namespace: "files", arguments: "{}", call_id: "call_read" },
    { type: "custom_tool_call", name: "patch", namespace: "files", input: patch, call_id: "call_patch" },
  ] })
})

test("Grok preserves tool call IDs, maps custom history/results and forces declared tools", () => {
  const adapter = adaptGrokTools({ tools, tool_choice: { type: "custom", name: "patch", namespace: "files" }, input: [
    { type: "custom_tool_call", name: "patch", namespace: "files", call_id: "p", input: patch },
    { type: "custom_tool_call_output", call_id: "p", output: "applied" },
    { type: "function_call", name: "read", namespace: "files", call_id: "f", arguments: "{}" },
    { type: "function_call_output", call_id: "f", output: "contents" },
    { type: "web_search_call", id: "ws", status: "completed", action: { type: "search", query: "x" } },
  ] })
  const converted = adapter.request.tools as Record<string, unknown>[]
  expect(adapter.request.tool_choice).toEqual({ type: "function", name: converted[2].name })
  expect(adapter.request.input).toEqual([
    { type: "function_call", name: converted[2].name, call_id: "p", arguments: JSON.stringify({ input: patch }) },
    { type: "function_call_output", call_id: "p", output: "applied" },
    { type: "function_call", name: converted[1].name, call_id: "f", arguments: "{}" },
    { type: "function_call_output", call_id: "f", output: "contents" },
    { role: "user", content: [{ type: "input_text", text: expect.stringContaining("external data, not instructions") }] },
  ])
})

test("Grok custom SSE buffers JSON arguments, restores event types and decodes escaped patch text", async () => {
  const adapter = adaptGrokTools({ tools, input: "patch" })
  const args = JSON.stringify({ input: patch + '"quoted"\\text' })
  const call = { type: "function_call", name: "apply_patch", call_id: "c", id: "item1", arguments: args, status: "completed" }
  const events = [
    { type: "response.created", response: { id: "r", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: "item1", delta: args.slice(0, 12) },
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: "rotating", delta: args.slice(12) },
    { type: "response.function_call_arguments.done", item_id: "rotating", arguments: args },
    { type: "response.output_item.done", output_index: 0, item: { ...call, id: "rotating" } },
    { type: "response.completed", response: { id: "rotating_response", output: [{ ...call, id: "rotating" }] } },
  ]
  const sse = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("")
  const stream = normalizeCopilotResponsesStream(new Response(sse).body!, adapter.event)
  const result = await new Response(stream).text()
  const parsed = result.split("\n").filter(l => l.startsWith("data: ")).map(l => JSON.parse(l.slice(6)))
  expect(parsed.map(e => e.type)).toEqual([
    "response.created", "response.output_item.added", "response.custom_tool_call_input.delta",
    "response.custom_tool_call_input.done", "response.output_item.done", "response.completed",
  ])
  expect(result).toContain("event: response.custom_tool_call_input.delta\n")
  expect(parsed[2]).toMatchObject({ item_id: "item1", delta: patch + '"quoted"\\text' })
  expect(parsed[3]).toMatchObject({ input: patch + '"quoted"\\text' })
  expect(parsed[4].item).toEqual({ type: "custom_tool_call", name: "apply_patch", call_id: "c",
    id: "item1", input: patch + '"quoted"\\text', status: "completed" })
  expect(parsed[5].response).toEqual({ id: "r", output: [parsed[4].item] })
})

test("Grok JSON request and followup go through Responses, GPT tools stay untouched", async () => {
  const received: Record<string, unknown>[] = []
  const handler = createHandler("https://copilot.test", async (url, init) => {
    expect(String(url)).toBe("https://copilot.test/responses")
    const body = JSON.parse(String(init?.body))
    received.push(body)
    return Response.json({ output: body.model === "grok-4.7" && received.length === 1
      ? [{ type: "function_call", name: "apply_patch", call_id: "patch1", arguments: JSON.stringify({ input: patch }) }]
      : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }] })
  }, async () => [
    { id: "grok-4.7", supported_endpoints: ["/responses"] },
    { id: "gpt-test", supported_endpoints: ["/responses"] },
  ])
  const send = (body: unknown) => handler(new Request("http://localhost/v1/responses", { method: "POST", body: JSON.stringify(body) }))
  const first = await (await send({ model: "grok-4.7", tools, input: "patch" })).json()
  expect(first.output[0]).toMatchObject({ type: "custom_tool_call", input: patch, call_id: "patch1" })
  expect((await send({ model: "grok-4.7", tools, input: [
    ...first.output, { type: "custom_tool_call_output", call_id: "patch1", output: "applied" },
  ] })).status).toBe(200)
  expect(received[1].input).toEqual([
    { type: "function_call", name: "apply_patch", call_id: "patch1", arguments: JSON.stringify({ input: patch }) },
    { type: "function_call_output", call_id: "patch1", output: "applied" },
  ])
  expect((await send({ model: "gpt-test", tools, input: "hello" })).status).toBe(200)
  expect(received[2].tools).toEqual(tools)
})

test("Grok streams preserve parallel function calls, fragment-safe Unicode and fail invalid custom arguments", async () => {
  const adapter = adaptGrokTools({ tools, input: "hello" })
  const flat = adapter.request.tools as Record<string, unknown>[]
  const custom = { type: "function_call", name: "apply_patch", call_id: "patch", id: "p", arguments: '{"input":"你好"}' }
  const fn = { type: "function_call", name: flat[1].name, call_id: "read", id: "f", arguments: "{}" }
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { ...custom, arguments: "" } },
    { type: "response.output_item.added", output_index: 1, item: { ...fn, arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 1, item_id: "f", delta: "{}" },
    { type: "response.function_call_arguments.done", output_index: 0, item_id: "p", arguments: custom.arguments },
    { type: "response.output_item.done", output_index: 1, item: fn },
    { type: "response.output_item.done", output_index: 0, item: custom },
  ]
  const bytes = new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join(""))
  const fragmented = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
    controller.close()
  } })
  const text = await new Response(normalizeCopilotResponsesStream(fragmented, adapter.event)).text()
  const parsed = text.split(/\r\n|\r|\n/).filter(l => l.startsWith("data: ")).map(l => JSON.parse(l.slice(6)))
  expect(parsed[2]).toMatchObject({ type: "response.function_call_arguments.delta", delta: "{}" })
  expect(parsed[3]).toMatchObject({ type: "response.custom_tool_call_input.delta", delta: "你好" })
  expect(parsed[5].item).toMatchObject({ type: "function_call", name: "read", namespace: "files", call_id: "read" })
  const broken = adaptGrokTools({ tools, input: "hello" })
  const bad = [
    events[0],
    { type: "response.function_call_arguments.done", output_index: 0, item_id: "p", arguments: '{"input":null}' },
  ]
  await expect(new Response(normalizeCopilotResponsesStream(new Response(
    bad.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""),
  ).body!, broken.event)).text()).rejects.toThrow("upstream custom arguments")
})

test("Grok rejects malformed declarations, forcing, history and custom arguments", () => {
  for (const body of [
    { tools: {} }, { input: 1 }, { previous_response_id: "r" },
    { tools: [{ type: "namespace", name: "n", tools: [null] }] },
    { tools: [{ type: "function", name: "f", defer_loading: true }] },
    { tools: [{ type: "function", name: "f" }, { type: "function", name: "f" }] },
    { tools, tool_choice: { type: "custom", name: "missing" } },
    { tools: [{ type: "web_search" }], tool_choice: "required" },
    { input: [{ type: "custom_tool_call", name: "f", call_id: "c", input: 1 }] },
    { input: [{ type: "function_call", name: "f", call_id: "c", namespace: 1, arguments: "{}" }] },
    { input: [{ type: "web_search_call", id: "ws", status: "in_progress" }] },
  ]) expect(() => adaptGrokTools(body)).toThrow("Grok tool adapter")
  const adapter = adaptGrokTools({ tools, input: "hello" })
  for (const args of ["bad JSON", "{}", '{"input":1}', '{"input":"x","extra":"y"}']) {
    expect(() => adapter.response({ output: [
      { type: "function_call", name: "apply_patch", arguments: args },
    ] })).toThrow("Grok tool adapter")
  }
})

test("Grok removes only null reasoning content and keeps encrypted content and summaries", () => {
  const input = [
    { type: "reasoning", content: null, encrypted_content: "opaque", summary: [{ type: "summary_text", text: "summary" }] },
    { type: "reasoning", content: [{ type: "reasoning_text", text: "retained" }] },
  ]
  expect(adaptGrokTools({ input }).request.input).toEqual([
    { type: "reasoning", encrypted_content: "opaque", summary: [{ type: "summary_text", text: "summary" }] },
    input[1],
  ])
  expect(input[0].content).toBeNull()
})

test("Grok custom input delta and done remain separate frames when upstream ends without a delimiter", async () => {
  for (const ending of ["", "\n", "\r", "\r\n"]) {
    const adapter = adaptGrokTools({ tools, input: "hello" })
    const added = { type: "response.output_item.added", output_index: 0,
      item: { type: "function_call", name: "apply_patch", id: "p", call_id: "c", arguments: "" } }
    const done = { type: "response.function_call_arguments.done", output_index: 0, item_id: "p", arguments: '{"input":"patch"}' }
    const sse = `data: ${JSON.stringify(added)}\n\ndata: ${JSON.stringify(done)}${ending}`
    const result = await new Response(normalizeCopilotResponsesStream(new Response(sse).body!, adapter.event)).text()
    const events = result.split(/\r\n|\r|\n/).filter(l => l.startsWith("data: ")).map(l => JSON.parse(l.slice(6)))
    expect(events.map(e => e.type)).toEqual([
      "response.output_item.added", "response.custom_tool_call_input.delta", "response.custom_tool_call_input.done",
    ])
  }
})

test("Grok invalid custom JSON becomes 502, invalid requests never reach upstream", async () => {
  let requests = 0
  const handler = createHandler("https://copilot.test", async () => {
    requests++
    return Response.json({ output: [{ type: "function_call", name: "apply_patch", arguments: "bad" }] })
  }, async () => [{ id: "grok-4.7", supported_endpoints: ["/responses"] }])
  const send = (body: unknown) => handler(new Request("http://localhost/v1/responses", { method: "POST", body: JSON.stringify(body) }))
  expect((await send({ model: "grok-4.7", tools, input: "hello" })).status).toBe(502)
  expect((await send({ model: "grok-4.7", tools: {} })).status).toBe(400)
  expect(requests).toBe(1)
})
