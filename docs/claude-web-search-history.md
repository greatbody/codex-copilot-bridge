# Claude Web Search History Compatibility

Codex can declare the OpenAI hosted `web_search` tool even when the latest user
message is ordinary text. The Claude Messages adapter now filters those tool
declarations instead of rejecting the whole request. Native Responses models
keep their existing web search behavior.

## Historical Records

- Completed `web_search_call` input items become labeled external reference data
  in a user content block. The JSON preserves the original ID, status, action,
  queries, sources, and any other supplied fields, including supplied results.
- Text content keeps its original text and appends a separately labeled JSON
  representation of its citation annotations, retaining URLs, titles and offsets.
- Function calls and their results keep the existing `call_id` mapping.
- The original input object is not modified. Responses still contain only the
  current turn's output; the client retains and replays its conversation history.

These are historical data records, not new tool executions. The bridge cannot
recover pages or results absent from the request, or translate opaque OpenAI
reasoning into Claude thinking.

Unfinished search records, missing IDs, malformed actions or annotations, and
cited assistant history that would otherwise be removed as trailing prefill are
rejected before an inference request is sent upstream. End cited history with a
user message or tool result. Explicitly forced web search is also rejected.

## Gateway Errors

Adapter validation failures use HTTP 400 and this error envelope:

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "claude_adapter_error",
    "message": "Cannot replay unfinished web search history. Complete the search with the original provider before switching models."
  }
}
```

Sub2API can preserve the HTTP status and error message with its existing error
passthrough rule mechanism. Use all conditions, not any condition:

```json
{
  "name": "Claude adapter compatibility errors",
  "enabled": true,
  "priority": 0,
  "error_codes": [400],
  "keywords": ["claude_adapter_error"],
  "match_mode": "all",
  "platforms": ["openai"],
  "passthrough_code": true,
  "passthrough_body": true,
  "skip_monitoring": false
}
```

Without this rule, the investigated Sub2API deployment changed adapter 400 errors
into generic 502 responses, causing unnecessary Codex retries. No Sub2API source
change is required for this deployment.

## Verification And Deployment

On 2026-09-23, 145 automated tests and `bun run check` passed. Live checks used
`claude-opus-5.5` with unique markers supplied only in historical queries, result
data and citation URLs. JSON and SSE replies preserved all markers; normal
conversation and function-tool continuation also passed.

Authenticated gateway checks confirmed history preservation, HTTP 400 for
invalid history and forced search, and a successful native GPT request.
An ephemeral Codex invocation with `web_search="live"` returned `BRIDGE_CODEX_OK`.

Verification records and deployment/rollback artifacts are kept locally and are
not part of public releases.
