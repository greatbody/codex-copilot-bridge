import { expect, test } from "bun:test"
import { createHandler } from "../src/server"

type Item = { id: string; type: string; [key: string]: unknown }
type StreamEvent = {
  type: string
  sequence_number: number
  response_id?: string
  output_index?: number
  item_id?: string
  item?: Item
  response?: { id: string; output: Item[]; [key: string]: unknown }
  [key: string]: unknown
}

const models = ["gpt-6-astra", "gpt-5.5"].map(id => ({ id, supported_endpoints: ["/responses"] }))

function fixture(prefix: string, model = "gpt-6-astra", rotating = true) {
  const originals: StreamEvent[] = []
  const expected: StreamEvent[] = []
  const ids = [0, 1, 2, 3].map(index => `${prefix}-item-${index}-first`)
  const responseID = `${prefix}-response-0`
  const text = "The same answer."
  const annotation = { type: "url_citation", start_index: 0, end_index: 4, url: "https://example.test", title: "Source", id: "annotation-id", nested: { item_id: "nested-item", response_id: "nested-response" } }
  const items: Item[] = [
    { id: ids[0]!, type: "reasoning", summary: [{ type: "summary_text", text: "Checked." }], encrypted_content: "opaque-reasoning-ciphertext" },
    { id: ids[1]!, type: "function_call", call_id: "call-must-not-change", name: "lookup", arguments: '{"id":"argument-id","item_id":"argument-item"}', status: "completed" },
    ...[2, 3].map(index => ({ id: ids[index]!, type: "message", role: "assistant", phase: index === 2 ? "commentary" : "final_answer", status: "completed", content: [{ type: "output_text", text, annotations: [annotation], logprobs: [] }] })),
  ]
  const snapshot = (output: Item[], status: string) => ({
    id: responseID, object: "response", model, status, output, created_at: 1788652800,
    service_tier: "priority", previous_response_id: "previous-response",
    metadata: { id: "metadata-id", item_id: "metadata-item", response_id: responseID, nested: { id: ids[0] } },
    usage: { input_tokens: 23, output_tokens: 17, total_tokens: 40, input_tokens_details: { cached_tokens: 9 }, output_tokens_details: { reasoning_tokens: 6 } },
  })
  function emit(event: Omit<StreamEvent, "sequence_number">) {
    const sequence = originals.length
    const canonical = { ...event, sequence_number: sequence, response_id: responseID } as StreamEvent
    expected.push(structuredClone(canonical))
    const original = structuredClone(canonical)
    if (rotating) {
      original.response_id = `${prefix}-response-${sequence}`
      if (original.response) {
        original.response.id = original.response_id
        original.response.output.forEach((item, index) => { item.id = `${prefix}-snapshot-${sequence}-${index}` })
      }
      if (original.item && original.type !== "response.output_item.added") original.item.id = `${prefix}-done-${sequence}`
      if (original.item_id) original.item_id = `${prefix}-delta-${sequence}`
    }
    originals.push(original)
  }
  emit({ type: "response.created", response: snapshot([], "in_progress") })
  for (const [index, item] of items.entries()) {
    emit({ type: "response.output_item.added", output_index: index, item: { ...item, status: "in_progress" } })
    if (index === 1) emit({ type: "response.in_progress", response: snapshot(items.slice(0, 2), "in_progress") })
    const identity = { output_index: index, item_id: ids[index] }
    if (index === 0) {
      emit({ type: "response.reasoning_summary_text.delta", ...identity, summary_index: 0, delta: "Checked." })
      emit({ type: "response.reasoning_summary_text.done", ...identity, summary_index: 0, text: "Checked." })
    } else if (index === 1) {
      emit({ type: "response.function_call_arguments.delta", ...identity, delta: item.arguments })
      emit({ type: "response.function_call_arguments.done", ...identity, arguments: item.arguments, name: item.name })
    } else {
      emit({ type: "response.content_part.added", ...identity, content_index: 0, part: { type: "output_text", text: "", annotations: [] } })
      emit({ type: "response.output_text.delta", ...identity, content_index: 0, delta: text, logprobs: [] })
      emit({ type: "response.output_text.annotation.added", ...identity, content_index: 0, annotation_index: 0, annotation })
      emit({ type: "response.output_text.done", ...identity, content_index: 0, text, logprobs: [] })
      emit({ type: "response.content_part.done", ...identity, content_index: 0, part: (item.content as unknown[])[0] })
    }
    emit({ type: "response.output_item.done", output_index: index, item })
  }
  emit({ type: "response.completed", response: snapshot(items, "completed") })
  return { originals, expected, ids, responseID }
}

function encodeSSE(events: StreamEvent[]) {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n"
}

function decodeSSE(text: string) {
  const data = text.split(/\r?\n\r?\n/).flatMap(frame => {
    const lines = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart())
    return lines.length ? [lines.join("\n")] : []
  })
  expect(data.at(-1)).toBe("[DONE]")
  expect(data.filter(value => value === "[DONE]")).toHaveLength(1)
  return data.slice(0, -1).map(value => JSON.parse(value) as StreamEvent)
}

// Simulate a client that upserts added/done items by ID, not by text or index.
function consumeMessages(events: StreamEvent[]) {
  const messages = new Map<string, Item>()
  for (const event of events) {
    if ((event.type === "response.output_item.added" || event.type === "response.output_item.done") && event.item?.type === "message") {
      messages.set(event.item.id, event.item)
    }
  }
  return messages
}

function assertNormalized(events: StreamEvent[], source: ReturnType<typeof fixture>) {
  expect(events).toHaveLength(source.originals.length)
  for (const [index, original] of source.originals.entries()) {
    // Only protocol identity slots may differ; nested IDs and all payloads remain intact.
    const expected = structuredClone(original)
    expected.response_id = source.responseID
    if (expected.response) {
      expected.response.id = source.responseID
      expected.response.output.forEach((item, outputIndex) => { item.id = source.ids[outputIndex]! })
    }
    if (expected.item) expected.item.id = source.ids[expected.output_index!]!
    if (expected.item_id) expected.item_id = source.ids[expected.output_index!]!
    expect(events[index]).toEqual(expected)
  }
  expect(events).toEqual(source.expected)
}

type Send = (body: Record<string, unknown>) => Promise<Response>

async function withBridge(respond: (request: Request) => Response | Promise<Response>, run: (send: Send) => Promise<void>) {
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    expect(new URL(request.url).pathname).toBe("/responses")
    expect(request.headers.has("authorization")).toBe(false)
    return respond(request)
  } })
  const bridge = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createHandler(upstream.url.origin, fetch, async () => models) })
  try {
    await run(body => fetch(new URL("/v1/responses", bridge.url), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }))
  } finally {
    bridge.stop(true)
    upstream.stop(true)
  }
}

for (const model of ["gpt-6-astra", "gpt-5.5"]) {
  test(`native ${model} rotating identities yield two messages, not four`, async () => {
    const source = fixture("rotating", model)
    expect(consumeMessages(source.originals).size).toBe(4)
    await withBridge(() => new Response(encodeSSE(source.originals), { headers: { "content-type": "text/event-stream" } }), async send => {
      const response = await send({ model, stream: true, input: "hello" })
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/event-stream")
      const events = decodeSSE(await response.text())
      const messages = consumeMessages(events)
      expect(messages.size).toBe(2)
      expect([...messages.keys()]).toEqual(source.ids.slice(2))
      expect([...messages.values()].map(item => item.content)).toEqual([
        source.expected.at(-1)!.response!.output[2]!.content,
        source.expected.at(-1)!.response!.output[3]!.content,
      ])
      assertNormalized(events, source)
    })
  })
}

test("native normalization preserves every payload field and snapshot output position", async () => {
  const source = fixture("payload")
  await withBridge(() => new Response(encodeSSE(source.originals), { headers: { "content-type": "text/event-stream; charset=utf-8" } }), async send => {
    const response = await send({ model: "gpt-6-astra", stream: true })
    assertNormalized(decodeSSE(await response.text()), source)
  })
})

test("native HTTP error SSE bodies pass through byte-for-byte", async () => {
  const body = encodeSSE(fixture("error").originals)
  await withBridge(() => new Response(body, {
    status: 429, statusText: "Too Many Requests", headers: { "content-type": "text/event-stream", "retry-after": "7", "x-request-id": "error-request" },
  }), async send => {
    const response = await send({ model: "gpt-6-astra", stream: true })
    expect(response.status).toBe(429)
    expect(response.statusText).toBe("Too Many Requests")
    expect(response.headers.get("retry-after")).toBe("7")
    expect(response.headers.get("x-request-id")).toBe("error-request")
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new TextEncoder().encode(body))
  })
})

test("native nonstream JSON passes through byte-for-byte even when streaming was requested", async () => {
  const body = ` \n${JSON.stringify(fixture("json").originals.at(-1)!.response, null, 2)}\n`
  await withBridge(() => new Response(body, { headers: { "content-type": "application/json", "x-request-id": "json-request" } }), async send => {
    for (const stream of [false, true]) {
      const response = await send({ model: "gpt-5.5", stream })
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("application/json")
      expect(response.headers.get("x-request-id")).toBe("json-request")
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new TextEncoder().encode(body))
    }
  })
})

test("native stable identities preserve stream semantics and identical-text messages", async () => {
  const source = fixture("stable", "gpt-5.5", false)
  await withBridge(() => new Response(encodeSSE(source.originals), { headers: { "content-type": "text/event-stream" } }), async send => {
    const response = await send({ model: "gpt-5.5", stream: true })
    const events = decodeSSE(await response.text())
    expect(events).toEqual(source.originals)
    expect(consumeMessages(events).size).toBe(2)
  })
})

test("concurrent native streams keep canonical identities request-local across split SSE chunks", async () => {
  const sources = [fixture("left"), fixture("right")]
  const bothStarted = Promise.withResolvers<void>()
  let started = 0
  await withBridge(async request => {
    const body = await request.json() as { input: number }
    const source = sources[body.input]!
    if (++started === 2) bothStarted.resolve()
    await bothStarted.promise
    return new Response(new ReadableStream<Uint8Array>({ async start(controller) {
      for (const frame of encodeSSE(source.originals).split("\n\n").filter(Boolean)) {
        const bytes = new TextEncoder().encode(`${frame}\n\n`)
        const midpoint = Math.floor(bytes.length / 2)
        controller.enqueue(bytes.slice(0, midpoint))
        await Bun.sleep(1)
        controller.enqueue(bytes.slice(midpoint))
      }
      controller.close()
    } }), { headers: { "content-type": "text/event-stream" } })
  }, async send => {
    const results = await Promise.all(sources.map(async (_, input) => {
      const response = await send({ model: "gpt-6-astra", stream: true, input })
      return decodeSSE(await response.text())
    }))
    expect(started).toBe(2)
    for (const [index, events] of results.entries()) assertNormalized(events, sources[index]!)
  })
})

test("successful native SSE removes stale representation headers but retains tracking headers", async () => {
  const source = fixture("headers")
  const compressed = Bun.gzipSync(encodeSSE(source.originals))
  const retained = {
    "x-request-id": "request-123",
    "x-github-request-id": "github-request-456",
    "x-copilot-trace-id": "trace-789",
    traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    "cache-control": "no-cache",
  }
  await withBridge(() => new Response(compressed, { headers: {
    "content-type": "text/event-stream; charset=utf-8",
    "content-encoding": "gzip",
    "content-length": String(compressed.byteLength),
    etag: '"original-body"',
    "content-md5": "original-md5",
    digest: "sha-256=original-digest",
    "content-digest": "sha-256=:original-content-digest:",
    "repr-digest": "sha-256=:original-repr-digest:",
    "accept-ranges": "bytes",
    "content-range": `bytes 0-${compressed.byteLength - 1}/${compressed.byteLength}`,
    ...retained,
  } }), async send => {
    const response = await send({ model: "gpt-6-astra", stream: true })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8")
    for (const header of ["content-encoding", "content-length", "etag", "content-md5", "digest", "content-digest", "repr-digest", "accept-ranges", "content-range"]) {
      expect(response.headers.has(header)).toBe(false)
    }
    for (const [header, value] of Object.entries(retained)) expect(response.headers.get(header)).toBe(value)
    assertNormalized(decodeSSE(await response.text()), source)
  })
})

for (const status of ["failed", "incomplete"]) {
  test(`native response.${status} retains terminal payloads and canonical response IDs`, async () => {
    const source = fixture(status)
    const error = status === "failed" ? {
      code: "server_error", message: "Synthetic upstream failure", param: null,
      details: { id: "error-id", response_id: "error-response", item_id: "error-item" },
    } : null
    const incompleteDetails = status === "incomplete" ? { reason: "max_output_tokens" } : null
    for (const events of [source.originals, source.expected]) {
      const terminal = events.at(-1)!
      terminal.type = `response.${status}`
      Object.assign(terminal.response!, { status, error, incomplete_details: incompleteDetails })
    }
    await withBridge(() => new Response(encodeSSE(source.originals), { headers: { "content-type": "text/event-stream" } }), async send => {
      const response = await send({ model: "gpt-6-astra", stream: true })
      expect(response.status).toBe(200)
      const events = decodeSSE(await response.text())
      assertNormalized(events, source)
      const terminal = events.at(-1)!
      expect(terminal.type).toBe(`response.${status}`)
      expect(terminal.response_id).toBe(events[0]!.response_id)
      expect(terminal.response!.id).toBe(events[0]!.response!.id)
      expect(terminal.response!.status).toBe(status)
      expect(terminal.response!.error).toEqual(error)
      expect(terminal.response!.incomplete_details).toEqual(incompleteDetails)
      expect(events.some(event => event.type === "response.completed")).toBe(false)
    })
  })
}

test("synthetic tool continuation sends normalized final output IDs and unchanged tool payloads upstream", async () => {
  const source = fixture("opaque:continuation/7f9")
  const expectedOutput = source.expected.at(-1)!.response!.output
  const originalCall = expectedOutput[1]!
  const toolOutput = '{"id":"result-id","item_id":"result-item","response_id":"result-response","value":42}'
  let requests = 0
  await withBridge(async request => {
    const body = await request.json() as { model: string; stream: boolean; input: Record<string, unknown>[] | string }
    expect(body.model).toBe("gpt-6-astra")
    expect(body.stream).toBe(true)
    requests++
    if (requests === 1) {
      expect(body.input).toBe("look up the value")
      return new Response(encodeSSE(source.originals), { headers: { "content-type": "text/event-stream" } })
    }
    expect(requests).toBe(2)
    expect(body.input).toEqual([
      ...expectedOutput,
      { type: "function_call_output", call_id: originalCall.call_id, output: toolOutput },
    ])
    const input = body.input as Record<string, unknown>[]
    expect(input.slice(0, -1).map(item => item.id)).toEqual(source.ids)
    expect(input[1]!.arguments).toBe(originalCall.arguments)
    expect(input[1]!.call_id).toBe(originalCall.call_id)
    expect(input.at(-1)!.call_id).toBe(originalCall.call_id)
    expect(input[0]!.encrypted_content).toBe(expectedOutput[0]!.encrypted_content)
    return new Response(encodeSSE(fixture("followup").originals), { headers: { "content-type": "text/event-stream" } })
  }, async send => {
    const first = await send({ model: "gpt-6-astra", stream: true, input: "look up the value" })
    expect(first.status).toBe(200)
    const events = decodeSSE(await first.text())
    assertNormalized(events, source)
    const output = events.at(-1)!.response!.output
    expect(output.map(item => item.id)).toEqual(source.ids)
    expect(output.map(item => item.id)).not.toEqual(source.originals.at(-1)!.response!.output.map(item => item.id))
    const call = output.find(item => item.type === "function_call")!
    const followup = await send({
      model: "gpt-6-astra", stream: true,
      input: [...output, { type: "function_call_output", call_id: call.call_id, output: toolOutput }],
    })
    expect(followup.status).toBe(200)
    assertNormalized(decodeSSE(await followup.text()), fixture("followup"))
  })
  expect(requests).toBe(2)
})

for (const cancellation of ["reader.cancel + AbortController", "AbortController"]) {
  test(`native HTTP streams deliver a frame before completion and propagate ${cancellation} upstream`, async () => {
    const disconnected = Promise.withResolvers<"cancel" | "abort">()
    const clientAbort = new AbortController()
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    let upstreamRequest: Request | undefined
    let upstreamCancelled = false
    let upstreamCompleted = false
    let finishUpstream: (() => void) | undefined
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const first = { type: "response.created", sequence_number: 0, response: { id: "http-first-opaque-id", output: [] } }
    const frame = `event: ${first.type}\ndata: ${JSON.stringify(first)}\n\n`
    const encoder = new TextEncoder()
    const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
      upstreamRequest = request
      expect(new URL(request.url).pathname).toBe("/responses")
      expect(request.headers.has("authorization")).toBe(false)
      request.signal.addEventListener("abort", () => {
        clearInterval(heartbeat)
        disconnected.resolve("abort")
      }, { once: true })
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(frame))
          // Stall model output, but keep transport writes active so Bun detects disconnects.
          heartbeat = setInterval(() => controller.enqueue(encoder.encode(": heartbeat\n\n")), 20)
          finishUpstream = () => {
            if (!upstreamCancelled) {
              upstreamCompleted = true
              controller.close()
            }
          }
        },
        cancel() {
          upstreamCancelled = true
          clearInterval(heartbeat)
          disconnected.resolve("cancel")
        },
      }), { headers: { "content-type": "text/event-stream" } })
    } })
    const bridge = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createHandler(upstream.url.origin, fetch, async () => models) })
    const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error(`HTTP ${cancellation} did not finish within 2000ms`)), 2000)
    })
    try {
      const response = await Promise.race([fetch(new URL("/v1/responses", bridge.url), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-6-astra", stream: true, input: "hello" }), signal: clientAbort.signal,
      }), timeout])
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/event-stream")
      reader = response.body!.getReader()
      let received = ""
      const decoder = new TextDecoder()
      while (!received.includes("\n\n")) {
        const chunk = await Promise.race([reader.read(), timeout])
        expect(chunk.done).toBe(false)
        received += decoder.decode(chunk.value, { stream: true })
      }
      expect(received.startsWith(frame)).toBe(true)
      expect(upstreamCompleted).toBe(false)
      expect(upstreamCancelled).toBe(false)
      expect(upstreamRequest!.signal.aborted).toBe(false)
      if (cancellation === "reader.cancel + AbortController") await Promise.race([reader.cancel("client finished"), timeout])
      // Bun may keep draining HTTP after reader.cancel(); explicitly abort the transport too.
      clientAbort.abort()
      await Promise.race([disconnected.promise, timeout])
      // Observe the real upstream before finally stops either server.
      expect(upstreamCancelled || upstreamRequest!.signal.aborted).toBe(true)
      expect(upstreamCompleted).toBe(false)
    } finally {
      clearTimeout(deadline)
      clearInterval(heartbeat)
      clientAbort.abort()
      if (reader) {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      finishUpstream?.()
      bridge.stop(true)
      upstream.stop(true)
    }
  }, 5000)
}
