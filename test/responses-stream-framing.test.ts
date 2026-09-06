import { expect, test } from "bun:test"
import { normalizeCopilotResponsesStream } from "../src/responses-stream"

const encoder = new TextEncoder()

function byteStream(bytes: Uint8Array, chunkSize = 1) {
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) controller.close()
      else {
        controller.enqueue(bytes.subarray(offset, offset + chunkSize))
        offset = Math.min(offset + chunkSize, bytes.length)
      }
    },
  })
}

function frame(event: unknown, ending = "\n") {
  return `data: ${JSON.stringify(event)}${ending}${ending}`
}

async function normalize(text: string) {
  const stream = normalizeCopilotResponsesStream(byteStream(encoder.encode(text)))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function within<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Stream operation timed out")), 1000) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function expectUnlocked(stream: ReadableStream<Uint8Array>) {
  for (let attempt = 0; stream.locked && attempt < 100; attempt++) await Bun.sleep(10)
  expect(stream.locked).toBe(false)
  const reader = stream.getReader()
  reader.releaseLock()
}

for (const [name, ending] of [["LF", "\n"], ["CRLF", "\r\n"], ["bare CR", "\r"]]) {
  test(`normalizes ${name} frames with every UTF-8 byte and line ending fragmented`, async () => {
    const first = { type: "response.output_text.delta", response_id: "response-first", output_index: 0, item_id: "item-first", delta: "\u00e9\u4e2d\ud83d\ude80" }
    const rotated = { ...first, response_id: "response-rotated", item_id: "item-rotated", delta: "\ud83c\udf0d\u6587\u00f1" }
    const input = frame(first, ending) + frame(rotated, ending)
    const expected = frame(first, ending) + frame({ ...rotated, response_id: first.response_id, item_id: first.item_id }, ending)
    expect(await normalize(input)).toEqual(encoder.encode(expected))
  })

  test(`preserves ${name} SSE metadata and keepalives while normalizing multiline data`, async () => {
    const seed = frame({ type: "response.created", response: { id: "response-first", output: [] } }, ending)
    const keepalive = [": keepalive", ":", "", ""].join(ending)
    const prefix = [": before data", "event: response.in_progress", "id: transport-id", "retry: 001500", "x-extension: untouched", "unknown-field"].join(ending) + ending
    const input = seed + keepalive + prefix
      + 'data: {"type":"response.in_progress",' + ending
      + ": between data" + ending
      + 'data:\t"response":{"id":"response-rotated","output":[]}}' + ending
      + "x-after: still here" + ending + ending
    const normalized = { type: "response.in_progress", response: { id: "response-first", output: [] } }
    const expected = seed + keepalive + prefix + `data: ${JSON.stringify(normalized)}` + ending
      + ": between data" + ending + "x-after: still here" + ending + ending
    expect(await normalize(input)).toEqual(encoder.encode(expected))
  })

  test(`stable ${name} frames remain byte-identical including JSON whitespace and multiline data`, async () => {
    const input = ': heartbeat' + ending + ending
      + 'event: response.created' + ending
      + 'data: { "type" : "response.created", "response" : { "id" : "r", "output" : [] } }' + ending + ending
      + 'data:{"type":"response.output_item.added","output_index":0,"item":{"id":"i","type":"message"}}' + ending + ending
      + 'id: stable-event' + ending + 'retry: 20' + ending
      + 'data: { "type": "response.output_text.delta",' + ending
      + ': keep this comment' + ending
      + 'data: "response_id": "r", "output_index": 0, "item_id": "i", "delta": "\u00e9\ud83d\ude80" }' + ending + ending
      + frame({ type: "response.output_item.done", output_index: 0, item: { id: "i", type: "message" } }, ending)
      + frame({ type: "response.completed", response: { id: "r", output: [{ id: "i", type: "message" }] } }, ending)
      + 'data: [DONE]' + ending + ending
    expect(await normalize(input)).toEqual(encoder.encode(input))
  })
}

test("unknown JSON events preserve all bytes and nested IDs without seeding identities", async () => {
  const unknown = 'event: response.vendor_extension\r\ndata: { "type": "response.vendor_extension", "response_id": "unknown-r", "output_index": 0, "item_id": "unknown-i", "item": {"id":"nested-i"}, "response": {"id":"nested-r","output":[{"id":"snapshot-i"}]}, "nested": {"id":"id","item_id":"item","response_id":"response"} }\r\n\r\n'
  const first = { type: "response.output_text.delta", response_id: "r", output_index: 0, item_id: "i", delta: "text" }
  const rotated = { ...first, response_id: "r-next", item_id: "i-next" }
  expect(await normalize(unknown + frame(first) + frame(rotated))).toEqual(encoder.encode(unknown + frame(first) + frame(first)))
})

for (const indexed of [false, true]) {
  test(`unknown output_text subevents ${indexed ? "with" : "without"} an index remain byte-exact and do not seed identities`, async () => {
    const unknown = 'event: response.output_text.future_event\r\nid: transport\r\ndata: { "type": "response.output_text.future_event",'
      + (indexed ? ' "output_index": 0,' : '')
      + ' "response_id": "unknown-r", "item_id": "unknown-i", "nested": {"id":"nested","item_id":"nested-i","response_id":"nested-r"} }\r\n\r\n'
    const first = { type: "response.output_text.delta", response_id: "r", output_index: 0, item_id: "i", delta: "text" }
    const rotated = { ...first, response_id: "r-next", item_id: "i-next" }
    const input = unknown + frame(first) + unknown + frame(rotated)
    expect(await normalize(input)).toEqual(encoder.encode(unknown + frame(first) + unknown + frame(first)))
  })
}

test("a byte-fragmented UTF-8 BOM is preserved on stable frames and the first known event seeds normalization", async () => {
  const first = '\ufeffdata: { "type": "response.created", "response": {"id":"r","output":[]} }\r\n\r\n'
  expect(await normalize(first)).toEqual(encoder.encode(first))
  const rotated = { type: "response.completed", response: { id: "rotated", output: [] } }
  expect(await normalize(first + frame(rotated))).toEqual(encoder.encode(first + frame({ ...rotated, response: { id: "r", output: [] } })))
})

test("a BOM on the first data line survives normalization within that frame", async () => {
  const event = { type: "response.created", response_id: "rotated", response: { id: "r", output: [] } }
  const input = "\ufeff" + frame(event, "\r\n")
  const expected = "\ufeff" + frame({ ...event, response_id: "r" }, "\r\n")
  expect(await normalize(input)).toEqual(encoder.encode(expected))
})

test("normalizes a 1 MiB data line delivered in 256-byte chunks", async () => {
  const first = { type: "response.output_text.delta", output_index: 0, item_id: "first", delta: "" }
  const large = { ...first, item_id: "rotated", delta: "x".repeat(1024 * 1024) }
  const input = encoder.encode(frame(first) + frame(large))
  const upstream = byteStream(input, 256)
  const output = new Uint8Array(await new Response(normalizeCopilotResponsesStream(upstream)).arrayBuffer())
  expect(output).toEqual(encoder.encode(frame(first) + frame({ ...large, item_id: "first" })))
}, 5000)

test("malformed JSON, non-JSON, non-object JSON, and [DONE] pass through unchanged", async () => {
  const input = [
    'data: {"type":"response.created",broken}\n\n',
    'event: keepalive\r\ndata: not JSON\r\n\r\n',
    'data: [DONE]\r\r',
    'data\n\n',
    'data: null\n\ndata: [1,{"item_id":"unchanged"}]\n\n',
    'data: "string"\n\ndata: 42\n\ndata: true\n\n',
  ].join("")
  expect(await normalize(input)).toEqual(encoder.encode(input))
})

for (const ending of ["", "\n", "\r\n", "\r"]) {
  test(`normalizes a valid EOF frame ending in ${JSON.stringify(ending)} without adding a delimiter`, async () => {
    const seed = frame({ type: "response.created", response: { id: "r", output: [] } })
    const input = seed + 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"rotated","output":[]}}' + ending
    const expected = seed + 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","output":[]}}' + ending
    expect(await normalize(input)).toEqual(encoder.encode(expected))
  })
}

test("an indexed delta before any start establishes canonical IDs for added, done, and final snapshot", async () => {
  const events = [
    { type: "response.output_text.delta", response_id: "r-first", output_index: 0, item_id: "i-first", delta: "hello" },
    { type: "response.created", response_id: "r-created", response: { id: "r-created", output: [] } },
    { type: "response.output_item.added", response_id: "r-added", output_index: 0, item: { id: "i-added", type: "message" } },
    { type: "response.output_item.done", response_id: "r-done", output_index: 0, item_id: "i-done-ref", item: { id: "i-done", type: "message" } },
    { type: "response.completed", response_id: "r-final", response: { id: "r-final", output: [{ id: "i-final", type: "message" }] } },
  ]
  const expected = [
    events[0],
    { type: "response.created", response_id: "r-first", response: { id: "r-first", output: [] } },
    { ...events[2], response_id: "r-first", item: { id: "i-first", type: "message" } },
    { ...events[3], response_id: "r-first", item_id: "i-first", item: { id: "i-first", type: "message" } },
    { type: "response.completed", response_id: "r-first", response: { id: "r-first", output: [{ id: "i-first", type: "message" }] } },
  ]
  expect(await normalize(events.map(event => frame(event)).join(""))).toEqual(encoder.encode(expected.map(event => frame(event)).join("")))
})

test("a known rotating alias resolves missing indices even with another active item and after done", async () => {
  const starts = [0, 1].map(output_index => frame({ type: "response.output_item.added", output_index, item: { id: `i-${output_index}`, type: "message" } })).join("")
  const delta = { type: "response.output_text.delta", output_index: 0, item_id: "rotated-alias", delta: "same text" }
  const done = { type: "response.output_item.done", item: { id: "rotated-alias", type: "message" } }
  const textDone = { type: "response.output_text.done", item_id: "rotated-alias", text: "same text" }
  const input = starts + frame(delta) + frame(done) + frame(textDone)
  const expected = starts + frame({ ...delta, item_id: "i-0" }) + frame({ ...done, item: { ...done.item, id: "i-0" } }) + frame({ ...textDone, item_id: "i-0" })
  expect(await normalize(input)).toEqual(encoder.encode(expected))
})

test("missing indices with new IDs match the sole observed active reasoning item despite an unrelated message", async () => {
  const prefix = frame({ type: "response.output_item.added", output_index: 0, item: { id: "message", type: "message" } })
    + frame({ type: "response.output_item.added", output_index: 1, item: { id: "active", type: "reasoning" } })
  const delta = { type: "response.reasoning_summary_text.delta", item_id: "new-delta", summary_index: 0, delta: "thought" }
  const textDone = { type: "response.reasoning_summary_text.done", item_id: "new-text-done", summary_index: 0, text: "thought" }
  const done = { type: "response.output_item.done", item: { id: "new-done", type: "reasoning" } }
  const input = prefix + frame(delta) + frame(textDone) + frame(done)
  const expected = prefix + frame({ ...delta, item_id: "active" }) + frame({ ...textDone, item_id: "active" }) + frame({ ...done, item: { ...done.item, id: "active" } })
  expect(await normalize(input)).toEqual(encoder.encode(expected))
})

for (const event of [
  { type: "response.reasoning_summary_text.delta", item_id: "rotating-B", delta: "thought" },
  { type: "response.reasoning_summary_text.done", item_id: "late-rotating-A", text: "thought" },
]) {
  test(`${event.type} without an index rejects historical reasoning A plus active B rather than attributing to B`, async () => {
    const valid = [
      frame({ type: "response.output_item.added", output_index: 0, item: { id: "A", type: "reasoning" } }),
      frame({ type: "response.output_item.done", output_index: 0, item: { id: "A", type: "reasoning" } }),
      frame({ type: "response.output_item.added", output_index: 1, item: { id: "B", type: "reasoning" } }),
    ]
    const reader = normalizeCopilotResponsesStream(byteStream(encoder.encode(valid.join("") + frame(event)))).getReader()
    try {
      for (const expected of valid) expect(await reader.read()).toEqual({ done: false, value: encoder.encode(expected) })
      await expect(reader.read()).rejects.toThrow("Copilot SSE cannot correlate item without output_index")
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  })
}

test("the sole observed reasoning item cannot accept an unknown unindexed ID after completion", async () => {
  const input = frame({ type: "response.output_item.done", output_index: 0, item: { id: "A", type: "reasoning" } })
    + frame({ type: "response.reasoning_summary_text.done", item_id: "late-A", text: "thought" })
  await expect(normalize(input)).rejects.toThrow("Copilot SSE cannot correlate item without output_index")
})

test("late output_text.done for completed message A cannot be attributed to active message B", async () => {
  const input = frame({ type: "response.output_item.added", output_index: 0, item: { id: "A", type: "message" } })
    + frame({ type: "response.output_item.done", output_index: 0, item: { id: "A", type: "message" } })
    + frame({ type: "response.output_item.added", output_index: 1, item: { id: "B", type: "message" } })
    + frame({ type: "response.output_text.done", item_id: "late-rotating-A", text: "identical text" })
  await expect(normalize(input)).rejects.toThrow("Copilot SSE cannot correlate item without output_index")
})

for (const [itemType, eventType] of [["message", "response.output_text.delta"], ["reasoning", "response.reasoning_summary_text.delta"], ["function_call", "response.function_call_arguments.delta"]]) {
  test(`multiple active ${itemType} items reject a rotating ID without an index rather than merging`, async () => {
    const starts = [0, 1].map(output_index => frame({ type: "response.output_item.added", output_index, item: { id: `i-${output_index}`, type: itemType } }))
    const deltas = [0, 1].map(output_index => frame({ type: eventType, output_index, item_id: `i-${output_index}`, delta: "identical" }))
    const valid = [...starts, ...deltas]
    const input = valid.join("") + frame({ type: eventType, item_id: "unknown-rotating-id", delta: "identical" })
    const reader = normalizeCopilotResponsesStream(byteStream(encoder.encode(input))).getReader()
    try {
      for (const expected of valid) expect(await reader.read()).toEqual({ done: false, value: encoder.encode(expected) })
      await expect(reader.read()).rejects.toThrow("Copilot SSE cannot correlate item without output_index")
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  })
}

for (const event of [
  { type: "response.output_item.added", item: { id: "unknown", type: "message" } },
  { type: "response.output_text.delta", item_id: "unknown", delta: "text" },
  { type: "response.reasoning_summary_text.delta", item_id: "unknown", delta: "thought" },
]) {
  test(`${event.type} deliberately rejects an unknown item when both start and index are missing`, async () => {
    await expect(normalize(frame(event))).rejects.toThrow("Copilot SSE cannot correlate item without output_index")
  })
}

test("an unindexed added event does not guess the sole active item's identity", async () => {
  const input = frame({ type: "response.output_item.added", output_index: 0, item: { id: "known", type: "message" } })
    + frame({ type: "response.output_item.added", item: { id: "unknown", type: "message" } })
  await expect(normalize(input)).rejects.toThrow("Copilot SSE cannot correlate item without output_index")
})

test("a complete frame is readable before the producer is allowed to finish", async () => {
  const finish = Promise.withResolvers<void>()
  let completed = false
  const bytes = encoder.encode(frame({ type: "response.created", response: { id: "r", output: [] } }))
  const upstream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(bytes)
      await finish.promise
      completed = true
      controller.close()
    },
  })
  const reader = normalizeCopilotResponsesStream(upstream).getReader()
  try {
    expect(await within(reader.read())).toEqual({ done: false, value: bytes })
    expect(completed).toBe(false)
    finish.resolve()
    expect(await within(reader.read())).toEqual({ done: true, value: undefined })
    expect(completed).toBe(true)
    await expectUnlocked(upstream)
  } finally {
    finish.resolve()
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
})

test("downstream cancellation forwards the exact reason and eventually unlocks the upstream reader", async () => {
  const cancelled = Promise.withResolvers<unknown>()
  const upstream = new ReadableStream<Uint8Array>({ cancel(reason) { cancelled.resolve(reason) } })
  const reader = normalizeCopilotResponsesStream(upstream).getReader()
  const reason = { why: "client disconnected" }
  try {
    expect(upstream.locked).toBe(true)
    const pending = reader.read()
    await within(reader.cancel(reason))
    expect(await within(cancelled.promise)).toBe(reason)
    expect(await within(pending)).toEqual({ done: true, value: undefined })
    await expectUnlocked(upstream)
  } finally {
    reader.releaseLock()
  }
})

test("an upstream error propagates as the same Error and releases the upstream reader", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const upstream = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
  const reader = normalizeCopilotResponsesStream(upstream).getReader()
  const failure = new Error("upstream failed")
  try {
    const pending = reader.read()
    controller.error(failure)
    await expect(within(pending)).rejects.toBe(failure)
    await expectUnlocked(upstream)
  } finally {
    reader.releaseLock()
  }
})

test("a transform error cancels upstream with the same error and releases its reader", async () => {
  const cancelled = Promise.withResolvers<unknown>()
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(frame({ type: "response.output_text.delta", item_id: "unknown", delta: "text" }))) },
    cancel(reason) { cancelled.resolve(reason) },
  })
  const reader = normalizeCopilotResponsesStream(upstream).getReader()
  try {
    const failure = await within(reader.read()).then(() => { throw new Error("Expected normalization to reject") }, error => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toBe("Copilot SSE cannot correlate item without output_index")
    expect(await within(cancelled.promise)).toBe(failure)
    await expectUnlocked(upstream)
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
})

for (const [name, invalid] of [
  ["invalid continuation", [0xc3, 0x28]],
  ["stray continuation", [0x80]],
  ["overlong encoding", [0xc0, 0xaf]],
  ["truncated multibyte character at EOF", [0xf0, 0x9f, 0x9a]],
] as const) {
  test(`rejects invalid UTF-8: ${name}`, async () => {
    const bytes = new Uint8Array([...encoder.encode('data: {"text":"'), ...invalid])
    const upstream = byteStream(bytes)
    const stream = normalizeCopilotResponsesStream(upstream)
    await expect(new Response(stream).arrayBuffer()).rejects.toBeInstanceOf(TypeError)
    await expectUnlocked(upstream)
  })
}

for (const [kind, limit, message] of [
  ["items", 4096, "Copilot SSE exceeds 4096 output items"],
  ["aliases", 65536, "Copilot SSE exceeds 65536 item ID aliases"],
] as const) {
  test(`accepts exactly ${limit} ${kind} and reuse at capacity, then rejects one new identity`, async () => {
    let sent = 0
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === limit + 2) { controller.close(); return }
        const index = sent === limit ? 0 : sent === limit + 1 ? limit : sent
        controller.enqueue(encoder.encode(frame({ type: "response.output_item.done", output_index: kind === "items" ? index : 0, item: { id: `i-${index}`, type: "message" } })))
        sent++
      },
    })
    const reader = normalizeCopilotResponsesStream(upstream).getReader()
    let received = 0
    let last: Uint8Array | undefined
    try {
      const consume = async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) return
          received++
          last = value
        }
      }
      await expect(consume()).rejects.toThrow(message)
      expect(received).toBe(limit + 1)
      expect(last).toEqual(encoder.encode(frame({ type: "response.output_item.done", output_index: 0, item: { id: "i-0", type: "message" } })))
      await expectUnlocked(upstream)
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }, 10000)
}

for (const overflow of [false, true]) {
  test(`${overflow ? "rejects one code unit above" : "accepts exactly"} the 16 MiB unterminated frame limit`, async () => {
    const limit = 16 * 1024 * 1024
    const chunk = encoder.encode("x".repeat(64 * 1024))
    let remaining = limit + Number(overflow)
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!remaining) { controller.close(); return }
        const size = Math.min(remaining, chunk.length)
        controller.enqueue(chunk.subarray(0, size))
        remaining -= size
      },
    })
    const reader = normalizeCopilotResponsesStream(upstream).getReader()
    try {
      if (overflow) await expect(reader.read()).rejects.toThrow("Copilot SSE frame exceeds 16 MiB")
      else {
        const result = await reader.read()
        expect(result.done).toBe(false)
        expect(result.value?.length).toBe(limit)
        expect(result.value?.every(byte => byte === 120)).toBe(true)
        expect((await reader.read()).done).toBe(true)
      }
      await expectUnlocked(upstream)
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }, 5000)
}

test("a CRCR-terminated frame is delivered immediately while upstream remains open", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const upstream = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
  const reader = normalizeCopilotResponsesStream(upstream).getReader()
  const bytes = encoder.encode(frame({ type: "response.created", response: { id: "r", output: [] } }, "\r"))
  try {
    controller.enqueue(bytes)
    expect(await within(reader.read())).toEqual({ done: false, value: bytes })
    controller.close()
    expect(await within(reader.read())).toEqual({ done: true, value: undefined })
    await expectUnlocked(upstream)
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
})

test("a split CRLF preserves the trailing LF after its frame has already been delivered", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const upstream = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
  const reader = normalizeCopilotResponsesStream(upstream).getReader()
  const first = frame({ type: "response.created", response: { id: "r", output: [] } }, "\r\n")
  const next = { type: "response.completed", response: { id: "rotated", output: [] } }
  try {
    controller.enqueue(encoder.encode(first.slice(0, -1)))
    expect(await within(reader.read())).toEqual({ done: false, value: encoder.encode(first.slice(0, -1)) })
    controller.enqueue(encoder.encode("\n"))
    expect(await within(reader.read())).toEqual({ done: false, value: encoder.encode("\n") })
    controller.enqueue(encoder.encode(frame(next, "\r\n")))
    expect(await within(reader.read())).toEqual({ done: false, value: encoder.encode(frame({ ...next, response: { id: "r", output: [] } }, "\r\n")) })
    controller.close()
    expect(await within(reader.read())).toEqual({ done: true, value: undefined })
    await expectUnlocked(upstream)
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
})

test("128 KiB of blank LF frames in one input chunk produces one lossless output chunk", async () => {
  const bytes = encoder.encode("\n".repeat(128 * 1024))
  const upstream = byteStream(bytes, bytes.length)
  const reader = normalizeCopilotResponsesStream(upstream).getReader()
  try {
    expect(await within(reader.read())).toEqual({ done: false, value: bytes })
    expect(await within(reader.read())).toEqual({ done: true, value: undefined })
    await expectUnlocked(upstream)
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
})

test("a stalled downstream bounds upstream pulls to a small fixed prefetch", async () => {
  let pulls = 0
  const bytes = encoder.encode(": keepalive\n\n")
  const upstream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++
      controller.enqueue(bytes)
      if (pulls === 32) controller.close()
    },
  })
  const reader = normalizeCopilotResponsesStream(upstream).getReader()
  try {
    // Yield event-loop turns, not a timed sleep, so pipe prefetch can settle.
    await new Promise<void>(resolve => setImmediate(resolve))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(pulls).toBeGreaterThan(0)
    expect(pulls).toBeLessThanOrEqual(3)
    const beforeRead = pulls
    expect(await within(reader.read())).toEqual({ done: false, value: bytes })
    await new Promise<void>(resolve => setImmediate(resolve))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(pulls).toBeLessThanOrEqual(beforeRead + 3)
  } finally {
    await within(reader.cancel())
    reader.releaseLock()
    await expectUnlocked(upstream)
  }
})

for (const fragmented of [false, true]) {
  for (const ending of ["\r\n", "\r\n\r\n"]) {
    for (const overflow of [false, true]) {
      test(`${fragmented ? "fragmented" : "single-chunk"} ${JSON.stringify(ending)} counts every code unit and ${overflow ? "rejects limit + 1" : "accepts the exact frame limit"}`, async () => {
        const limit = 16 * 1024 * 1024
        const contentLength = limit - ending.length + Number(overflow)
        const block = encoder.encode("x".repeat(fragmented ? 64 * 1024 : contentLength) + (fragmented ? "" : ending))
        let remaining = contentLength
        let endingOffset = 0
        let sent = false
        const upstream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!fragmented) {
              if (sent) controller.close()
              else { controller.enqueue(block); sent = true }
            } else if (remaining) {
              const size = Math.min(remaining, block.length)
              controller.enqueue(block.subarray(0, size))
              remaining -= size
            } else if (endingOffset < ending.length) {
              controller.enqueue(encoder.encode(ending[endingOffset++]))
            } else controller.close()
          },
        })
        const reader = normalizeCopilotResponsesStream(upstream).getReader()
        let received = 0
        let contentIntact = true
        const suffix: number[] = []
        try {
          const consume = async () => {
            while (true) {
              const { done, value } = await reader.read()
              if (done) return
              const contentBytes = Math.max(0, Math.min(value.length, contentLength - received))
              contentIntact &&= value.subarray(0, contentBytes).every(byte => byte === 120)
              for (const byte of value.subarray(contentBytes)) suffix.push(byte)
              received += value.length
            }
          }
          if (overflow) await expect(consume()).rejects.toThrow("Copilot SSE frame exceeds 16 MiB")
          else {
            await consume()
            expect(received).toBe(limit)
            expect(contentIntact).toBe(true)
            expect(suffix).toEqual([...encoder.encode(ending)])
          }
          await expectUnlocked(upstream)
        } finally {
          await reader.cancel().catch(() => {})
          reader.releaseLock()
        }
      }, 5000)
    }
  }
}
