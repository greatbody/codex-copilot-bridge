import { describe, expect, test } from "bun:test"
import { buildCodexModels, clearCopilotModelsCache, loadCopilotModels, selectCopilotEndpoint } from "../src/copilot"

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
