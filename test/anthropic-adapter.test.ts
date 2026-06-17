import { describe, expect, test } from "bun:test"
import { anthropicStreamToResponsesStream, anthropicToResponses, responsesToAnthropicMessages } from "../src/anthropic-adapter"

async function readStream(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let output = ""
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    output += decoder.decode(chunk.value)
  }
  return output
}

function streamFromText(text: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

describe("responsesToAnthropicMessages", () => {
  test("maps instructions, text input, max_output_tokens, function tools, and tool_choice", () => {
    const result = responsesToAnthropicMessages({
      model: "claude-sonnet-4",
      instructions: "Be terse.",
      input: "Hello",
      reasoning: { effort: "high" },
      max_output_tokens: 321,
      tools: [
        { type: "image_generation" },
        {
          type: "function",
          name: "lookup",
          description: "Look up a thing",
          parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
        },
      ],
      tool_choice: { type: "function", name: "lookup" },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect(result.value).toMatchObject({
      model: "claude-sonnet-4",
      system: "Be terse.",
      max_tokens: 321,
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      tools: [
        {
          name: "lookup",
          description: "Look up a thing",
          input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
        },
      ],
      tool_choice: { type: "tool", name: "lookup" },
    })
  })

  test("maps message arrays, images, assistant function calls, and tool results", () => {
    const result = responsesToAnthropicMessages({
      model: "claude-sonnet-4",
      input: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "internal summary" }] },
        {
          role: "user",
          content: [
            { type: "input_text", text: "What is in this image?" },
            { type: "reasoning", text: "drop me" },
            { type: "input_image", image_url: "data:image/png;base64,abc123" },
          ],
        },
        { type: "function_call", call_id: "call_1", name: "inspect", arguments: "{\"ok\":true}" },
        { type: "function_call_output", call_id: "call_1", output: "done" },
        { role: "tool", tool_call_id: "call_2", content: "tool role done" },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect(result.value.max_tokens).toBe(4096)
    expect(result.value.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
        ],
      },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "inspect", input: { ok: true } }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "done" },
          { type: "tool_result", tool_use_id: "call_2", content: "tool role done" },
        ],
      },
    ])
  })

  test("rejects hosted OpenAI tools and previous_response_id while dropping reasoning blocks", () => {
    const hostedTool = responsesToAnthropicMessages({
      model: "claude-sonnet-4",
      input: "hi",
      tools: [{ type: "web_search_preview" }],
    })
    expect(hostedTool.ok).toBe(false)
    if (hostedTool.ok) throw new Error("expected hosted tool rejection")
    expect(hostedTool.message).toContain("not supported")

    const previous = responsesToAnthropicMessages({
      model: "claude-sonnet-4",
      input: "hi",
      previous_response_id: "resp_123",
    })
    expect(previous.ok).toBe(false)
    if (previous.ok) throw new Error("expected previous_response_id rejection")
    expect(previous.message).toContain("previous_response_id")

    const encrypted = responsesToAnthropicMessages({
      model: "claude-sonnet-4",
      input: [{ type: "reasoning", encrypted_content: "secret" }, { role: "user", content: "hi" }],
      include: ["reasoning.encrypted_content"],
    })
    expect(encrypted.ok).toBe(true)
    if (!encrypted.ok) throw new Error(encrypted.message)
    expect(encrypted.value.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }])
  })

  test("drops trailing assistant text prefill because Claude requires the conversation to end with a user message", () => {
    const result = responsesToAnthropicMessages({
      model: "claude-sonnet-4",
      input: [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "output_text", text: "prefill" }] },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect(result.value.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }])
  })
})

describe("anthropicToResponses", () => {
  test("maps text, tool_use, and usage", () => {
    const response = anthropicToResponses(
      {
        id: "msg_123",
        model: "claude-sonnet-4",
        content: [
          { type: "text", text: "Hello" },
          { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      "fallback",
    )

    expect(response).toMatchObject({
      id: "msg_123",
      object: "response",
      status: "completed",
      model: "claude-sonnet-4",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello", annotations: [] }],
        },
        {
          type: "function_call",
          call_id: "toolu_1",
          name: "lookup",
          arguments: "{\"q\":\"x\"}",
          status: "completed",
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    })
  })
})

describe("anthropicStreamToResponsesStream", () => {
  test("converts Anthropic text and tool streaming events to Responses SSE", async () => {
    const anthropicSSE = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4","usage":{"input_tokens":2}}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"lookup","input":{}}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"x\\"}"}}',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":3}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
      "",
    ].join("\n\n")

    const converted = await readStream(anthropicStreamToResponsesStream(streamFromText(anthropicSSE), "fallback"))

    expect(converted).toContain("event: response.created")
    expect(converted).toContain("event: response.output_text.delta")
    expect(converted).toContain('"delta":"Hi"')
    expect(converted).toContain("event: response.function_call_arguments.delta")
    expect(converted).toContain('"arguments":"{\\"q\\":\\"x\\"}"')
    expect(converted).toContain("event: response.completed")
    expect(converted).toContain('"total_tokens":5')
    expect(converted).toContain("data: [DONE]")
  })
})
