import { expect, test } from "bun:test"
import { anthropicStreamToResponsesStream, anthropicToResponses, responsesToAnthropicMessages } from "../src/anthropic-adapter"
import { AnthropicReasoningCache } from "../src/reasoning-cache"

const thinking = { type: "thinking", thinking: "provider thinking", signature: "opaque-signature" } as const
const redacted = { type: "redacted_thinking", data: "opaque-data" } as const
const tool = { type: "tool_use", id: "call_1", name: "read_file", input: {} } as const

function followUp(model = "claude", callID = "call_1") {
  const result = responsesToAnthropicMessages({ model, input: [
    { type: "function_call", call_id: callID, name: "read_file", arguments: "{}" },
    { type: "function_call_output", call_id: callID, output: "contents" },
  ] })
  if (!result.ok) throw new Error(result.message)
  return result.value
}

test("non-streaming tool continuation replays opaque thinking and counts all input tokens", () => {
  const cache = new AnthropicReasoningCache()
  const response = anthropicToResponses({ content: [thinking, redacted, tool],
    usage: { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 10 },
  }, "claude", content => cache.store(content, "claude"))
  expect(response.usage).toEqual({ input_tokens: 1205, input_tokens_details: { cached_tokens: 1000 }, output_tokens: 10, total_tokens: 1215 })
  expect(JSON.stringify(response)).not.toContain("opaque-signature")
  const request = followUp()
  cache.apply(request)
  cache.apply(request)
  expect(request.messages[0]?.content).toEqual([thinking, redacted, tool])
  const other = followUp("other-model")
  cache.apply(other)
  expect(other.messages[0]?.content).toEqual([tool])
})

test("streamed thinking signatures survive split deltas and tool continuation", async () => {
  const cache = new AnthropicReasoningCache()
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 2, cache_read_input_tokens: 20 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: thinking.thinking } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "opaque-" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signature" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: redacted },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: tool },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{}" } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ]
  const stream = new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")).body
  const result = await new Response(anthropicStreamToResponsesStream(stream, "claude", content => cache.store(content, "claude"))).text()
  expect(result).toContain('"total_tokens":25')
  expect(result).not.toContain("opaque-signature")
  const request = followUp()
  cache.apply(request)
  expect(request.messages[0]?.content).toEqual([thinking, redacted, tool])
})

test("cache expiration and capacity prevent indefinite signature retention", () => {
  const cache = new AnthropicReasoningCache(10, 1)
  cache.store([thinking, tool], "claude", 0)
  cache.store([thinking, { ...tool, id: "call_2" }], "claude", 1)
  const evicted = followUp()
  cache.apply(evicted, 2)
  expect(evicted.messages[0]?.content).toEqual([tool])
  const expired = followUp("claude", "call_2")
  cache.apply(expired, 12)
  expect(expired.messages[0]?.content).toHaveLength(1)
})
