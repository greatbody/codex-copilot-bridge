import { expect, test } from "bun:test"
import { createHandler } from "../src/server"
import { buildCodexModels, clearCopilotModelsCache } from "../src/copilot"

test("HTTP discovery, thinking effort and tool continuation use the same capabilities", async () => {
  clearCopilotModelsCache()
  const metadata = { id: "claude-live", supported_endpoints: ["/v1/messages"], capabilities: {
    limits: { max_context_window_tokens: 200000, max_prompt_tokens: 168000, max_output_tokens: 64000 },
    supports: { adaptive_thinking: true, reasoning_effort: ["high", "xhigh", "max"] },
  } }
  const received: Record<string, unknown>[] = []
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    if (new URL(request.url).pathname === "/models") return Response.json({ data: [metadata] })
    expect(new URL(request.url).pathname).toBe("/v1/messages")
    expect(request.headers.get("anthropic-beta")).toBe("interleaved-thinking-2025-05-14")
    received.push(await request.json())
    return Response.json({ content: received.length === 1 ? [
      { type: "thinking", thinking: "retained", signature: "signature" },
      { type: "tool_use", id: "call_1", name: "read_file", input: {} },
    ] : [{ type: "text", text: "done" }] })
  } })
  const handler = createHandler(upstream.url.origin, fetch, undefined, async available => buildCodexModels(available))
  const bridge = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler })
  try {
    const models = await fetch(new URL("/v1/models", bridge.url)).then(r => r.json())
    expect(models.models[0]).toMatchObject({ context_window: 200000, auto_compact_token_limit: 148000, default_reasoning_level: "high" })
    const send = (body: unknown) => fetch(new URL("/v1/responses", bridge.url), { method: "POST", body: JSON.stringify(body) })
    const tools = [{ type: "web_search" }, { type: "function", name: "read_file", parameters: { type: "object" } }]
    const first = await send({ model: "claude-live", input: "read a file", reasoning: { effort: "xhigh" }, tools }).then(r => r.json())
    expect(received[0]).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "xhigh" }, max_tokens: 64000 })
    expect(received[0].tools).toEqual([{ name: "read_file", input_schema: { type: "object" } }])
    const followup = await send({ model: "claude-live", reasoning: { effort: "max" }, tools, input: [
      ...first.output, { type: "function_call_output", call_id: "call_1", output: "contents" },
    ] })
    expect(followup.status).toBe(200)
    expect(received[1]).toMatchObject({ output_config: { effort: "max" }, messages: [
      { role: "assistant", content: [{ type: "thinking", thinking: "retained", signature: "signature" }, { type: "tool_use", id: "call_1", name: "read_file", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "contents" }] },
    ] })
    expect((await followup.json()).output).toEqual([
      { type: "message", id: "msg_0", status: "completed", role: "assistant", content: [{ type: "output_text", text: "done", annotations: [] }] },
    ])
    expect((await send({ model: "claude-live", reasoning: { effort: "medium" } })).status).toBe(400)
    expect((await send(null)).status).toBe(400)
    expect(received).toHaveLength(2)
  } finally {
    bridge.stop(true)
    upstream.stop(true)
    clearCopilotModelsCache()
  }
})

test("only the Messages route filters web search and the response contains only new output", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = []
  const handler = createHandler("https://copilot.example.test", async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return String(url).endsWith("/v1/messages")
      ? Response.json({ content: [{ type: "text", text: "A17" }] })
      : Response.json({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "A17" }] }] })
  }, async () => [
    { id: "claude-test", supported_endpoints: ["/v1/messages"] },
    { id: "gpt-test", supported_endpoints: ["/responses"] },
  ])
  const input = [
    { role: "user", content: "Remember reference A17." },
    { role: "assistant", content: "Reference remembered." },
    { role: "user", content: "What was the reference?" },
  ]
  const original = structuredClone(input)
  for (const model of ["claude-test", "gpt-test"]) {
    const response = await handler(new Request("http://localhost/v1/responses", {
      method: "POST", body: JSON.stringify({ model, input, tools: [{ type: "web_search" }] }),
    }))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.output).toHaveLength(1)
    expect(body.output[0]).toMatchObject({ type: "message", role: "assistant", content: [{ type: "output_text", text: "A17" }] })
  }
  expect(input).toEqual(original)
  expect(requests[0].body.tools).toBeUndefined()
  expect(requests[0].body.messages).toEqual(input.map(message => ({
    role: message.role, content: [{ type: "text", text: message.content }],
  })))
  expect(requests[1].body.tools).toEqual([{ type: "web_search" }])
  expect(requests[1].body.input).toEqual(input)
})
