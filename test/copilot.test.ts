import { describe, expect, test } from "bun:test"
import { buildCodexModels, clearCopilotModelsCache, loadCopilotModels, selectCopilotEndpoint } from "../src/copilot"
import { rewriteCopilotFastResponsesRequest, sanitizeResponsesBody } from "../src/responses-sanitize"

describe("selectCopilotEndpoint", () => {
  test("prefers native /responses when available", () => {
    const selection = selectCopilotEndpoint(
      [{ id: "gpt", supported_endpoints: ["/v1/messages", "/responses"] }],
      "gpt",
    )

    expect(selection.kind).toBe("responses")
  })

  test("selects messages adapter for models without native /responses", () => {
    const selection = selectCopilotEndpoint(
      [{ id: "claude", supported_endpoints: ["/v1/messages"] }],
      "claude",
    )

    expect(selection.kind).toBe("messages")
  })

  test("returns clear unsupported selections", () => {
    expect(selectCopilotEndpoint([{ id: "legacy", supported_endpoints: ["/chat/completions"] }], "legacy")).toMatchObject({
      kind: "unsupported",
      message: expect.stringContaining("does not support /responses or /v1/messages"),
    })
    expect(selectCopilotEndpoint([], "missing")).toMatchObject({
      kind: "unsupported",
      message: expect.stringContaining("was not found"),
    })
  })
})

describe("loadCopilotModels", () => {
  test("coalesces discovery and retains the last good list on a transient failure", async () => {
    clearCopilotModelsCache()
    let finish!: (models: Array<{id: string}>) => void
    let calls = 0
    const loader = () => { calls++; return new Promise<Array<{id: string}>>(resolve => { finish = resolve }) }
    const first = loadCopilotModels(loader, 1000)
    const second = loadCopilotModels(loader, 1000)
    finish([{ id: "working" }])
    expect(await first).toEqual(await second)
    expect(calls).toBe(1)
    expect(await loadCopilotModels(async () => { throw new Error("offline") }, 32000)).toEqual([{ id: "working" }])
    clearCopilotModelsCache()
    await expect(loadCopilotModels(async () => { throw new Error("offline") }, 40000)).rejects.toThrow("offline")
    clearCopilotModelsCache()
  })
  test("caches model metadata briefly", async () => {
    clearCopilotModelsCache()
    let calls = 0
    const loader = async () => {
      calls += 1
      return [{ id: `model-${calls}` }]
    }

    expect(await loadCopilotModels(loader, 1_000)).toEqual([{ id: "model-1" }])
    expect(await loadCopilotModels(loader, 1_001)).toEqual([{ id: "model-1" }])
    expect(calls).toBe(1)

    expect(await loadCopilotModels(loader, 31_001)).toEqual([{ id: "model-2" }])
    expect(calls).toBe(2)
    clearCopilotModelsCache()
  })
})

describe("buildCodexModels", () => {
  test("uses live input limits and clears unrelated template capabilities", () => {
    const [model] = buildCodexModels([{
      id: "new", supported_endpoints: ["/v1/messages"],
      capabilities: { limits: { max_prompt_tokens: 168000, max_output_tokens: 64000 } },
    }], [{ slug: "other", context_window: 1000000, max_context_window: 1000000,
      auto_compact_token_limit: 900000, default_reasoning_level: "xhigh", input_modalities: ["text", "image"] }])
    expect(model).toMatchObject({ context_window: 168000, max_context_window: 168000,
      auto_compact_token_limit: 148000, default_reasoning_level: null,
      supported_reasoning_levels: [], input_modalities: ["text"] })
  })

  test("preserves total context separately from the safe input threshold", () => {
    const [model] = buildCodexModels([{
      id: "claude", supported_endpoints: ["/v1/messages"],
      capabilities: { limits: { max_context_window_tokens: 200000, max_prompt_tokens: 168000, max_output_tokens: 64000 },
        supports: { adaptive_thinking: true, reasoning_effort: ["high", "xhigh", "max"] } },
    }])
    expect(model).toMatchObject({ context_window: 200000, max_prompt_tokens: 168000,
      auto_compact_token_limit: 148000, default_reasoning_level: "high" })
    expect(model?.supported_reasoning_levels).toEqual(["high", "xhigh", "max"].map(effort => ({ effort, description: expect.any(String) })))
  })

  test("exposes budget variants only for a Messages model with a usable budget", () => {
    const [model] = buildCodexModels([{
      id: "claude", supported_endpoints: ["/v1/messages"],
      capabilities: { limits: { max_output_tokens: 32000 }, supports: { min_thinking_budget: 1024, max_thinking_budget: 32000 } },
    }])
    expect(model?.supported_reasoning_levels).toEqual(["high", "max"].map(effort => ({ effort, description: expect.any(String) })))
    expect(model?.context_window).toBeNull()
  })

  test("overlays cached Codex templates and appends uncached live Copilot models", () => {
    const models = buildCodexModels(
      [
        {
          id: "gpt-live",
          name: "GPT Live",
          model_picker_enabled: true,
          supported_endpoints: ["/responses"],
          capabilities: {
            limits: { max_context_window_tokens: 100, max_output_tokens: 10, max_prompt_tokens: 90 },
            supports: { reasoning_effort: ["low", "medium"], tool_calls: true },
          },
        },
        {
          id: "claude-live",
          name: "Claude Live",
          model_picker_enabled: true,
          supported_endpoints: ["/v1/messages", "/chat/completions"],
          capabilities: {
            limits: { max_context_window_tokens: 200, max_output_tokens: 20, max_prompt_tokens: 180 },
            supports: { reasoning_effort: ["high"], tool_calls: true },
          },
        },
      ],
      [
        {
          slug: "gpt-live",
          id: "gpt-live",
          display_name: "Cached GPT",
          base_instructions: "keep me",
          shell_type: "shell_command",
          model_messages: { instructions_template: "template" },
        },
      ],
    )

    expect(models).toHaveLength(2)
    expect(models[0]).toMatchObject({
      slug: "gpt-live",
      id: "gpt-live",
      display_name: "GPT Live",
      base_instructions: "keep me",
      supported_endpoints: ["/responses"],
      context_window: 100,
    })
    expect(models[1]).toMatchObject({
      slug: "claude-live",
      id: "claude-live",
      display_name: "Claude Live",
      base_instructions: "keep me",
      shell_type: "shell_command",
      model_messages: { instructions_template: "template" },
      supported_endpoints: ["/v1/messages", "/chat/completions"],
      visibility: "list",
      supported_in_api: true,
      priority: 50,
    })
  })

  test("filters disabled and bridge-incompatible models", () => {
    const models = buildCodexModels([
      { id: "disabled", supported_endpoints: ["/responses"], policy: { state: "disabled" } },
      { id: "chat-only", supported_endpoints: ["/chat/completions"], model_picker_enabled: true },
      { id: "messages", supported_endpoints: ["/v1/messages"], model_picker_enabled: true },
    ])

    expect(models.map((item) => item.id)).toEqual(["messages"])
  })
})

describe("sanitizeResponsesBody", () => {
  test("removes unsupported Codex internal metadata fields from input items", () => {
    const body = sanitizeResponsesBody(
      JSON.stringify({
        model: "gpt-5.5",
        input: [
          {
            role: "user",
            content: "hello",
            internal_chat_message_metadata_passthrough: { hidden: true },
          },
        ],
      }),
    )

    expect(JSON.parse(body)).toEqual({
      model: "gpt-5.5",
      input: [{ role: "user", content: "hello" }],
    })
  })

  test("keeps existing image generation tool filtering", () => {
    const body = sanitizeResponsesBody(
      JSON.stringify({
        tools: [{ type: "web_search" }, { type: "image_generation" }],
      }),
    )

    expect(JSON.parse(body).tools).toEqual([{ type: "web_search" }])
  })
})

describe("rewriteCopilotFastResponsesRequest", () => {
  test.each(["fast", "priority", "ultrafast"])("routes GPT-5.6 Sol %s requests through Copilot's fast model ID", (serviceTier) => {
    expect(
      rewriteCopilotFastResponsesRequest({
        model: "gpt-5.6-sol",
        service_tier: serviceTier,
        input: "hello",
      }),
    ).toEqual({
      model: "gpt-5.6-sol-fast",
      input: "hello",
    })
  })

  test.each(["fast", "priority", "ultrafast"])("removes %s from an explicitly selected Copilot fast model", (serviceTier) => {
    expect(
      rewriteCopilotFastResponsesRequest({
        model: "gpt-5.6-sol-fast",
        service_tier: serviceTier,
      }),
    ).toEqual({ model: "gpt-5.6-sol-fast" })
  })

  test("does not rewrite other tiers or model families", () => {
    const standard = { model: "gpt-5.6-sol", service_tier: "default" }
    const terra = { model: "gpt-5.6-terra", service_tier: "ultrafast" }

    expect(rewriteCopilotFastResponsesRequest(standard)).toBe(standard)
    expect(rewriteCopilotFastResponsesRequest(terra)).toBe(terra)
  })
})
