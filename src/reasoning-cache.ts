import type { AnthropicMessagesRequest, ThinkingBlock } from "./anthropic-adapter"

// Signatures are provider-opaque. Keep original blocks only in this process and
// replay them with the tool calls they accompanied, never as client-supplied text.
export class AnthropicReasoningCache {
  private entries = new Map<string, { expires: number; blocks: ThinkingBlock[] }>()

  constructor(private ttl = 3600000, private capacity = 4096) {}

  store(content: unknown, model: string, now = Date.now()) {
    if (!Array.isArray(content)) return
    const blocks: ThinkingBlock[] = content.filter(block =>
      block && typeof block === "object" && (
        (block.type === "thinking" && typeof block.thinking === "string" && typeof block.signature === "string" && block.signature.length > 0) ||
        (block.type === "redacted_thinking" && typeof block.data === "string")
      ),
    ).map(block => structuredClone(block))
    if (!blocks.length) return
    for (const [key, value] of this.entries) if (value.expires <= now) this.entries.delete(key)
    for (const block of content) {
      if (block?.type !== "tool_use" || typeof block.id !== "string") continue
      const key = JSON.stringify([model, block.id])
      this.entries.delete(key)
      this.entries.set(key, { expires: now + this.ttl, blocks })
    }
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!)
  }

  apply(request: AnthropicMessagesRequest, now = Date.now()) {
    for (const message of request.messages) {
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue
      if (message.content.some(block => block.type === "thinking" || block.type === "redacted_thinking")) continue
      for (const block of message.content) {
        if (block.type !== "tool_use") continue
        const key = JSON.stringify([request.model, block.id])
        const cached = this.entries.get(key)
        if (!cached) continue
        if (cached.expires <= now) {
          this.entries.delete(key)
          continue
        }
        message.content.unshift(...structuredClone(cached.blocks))
        break
      }
    }
  }
}
