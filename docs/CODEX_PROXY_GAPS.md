# Codex Proxy Gaps

This note captures gaps and behavior differences observed in our Codex proxy
implementation relative to expected Codex CLI behavior.

## Findings

- Parameter stripping: `codex-core` removes `max_output_tokens`, `max_tokens`,
  `temperature`, `top_p`, and `top_k`, so clients cannot control sampling or
  output length.
- Missing default instructions: fixed for the Claude `/v1/messages` -> Codex
  compatibility path via channel config `codexClaudeMessagesCompatEnabled`.
  Other direct Responses paths still preserve caller-provided `instructions`.
- Session/cache IDs: `Conversation_id` and `Session_id` are only set when
  `prompt_cache_key` is present, so multi-turn cohesion is weaker when no cache
  key is provided.
- Input normalization coverage: `normalizeCodexInput` maps text, images, and
  function calls, but does not explicitly normalize other input types
  (e.g. `input_file`, `mcp_*`, `code_interpreter`, `web_search`).
- SSE parsing: streaming parser only reads single-line `data:` entries and
  ignores `event:` lines or multi-line data chunks, so fragmented JSON can be
  dropped.
- Request filtering: fields like `metadata` are not stripped; if clients send
  non-Codex fields, they will be forwarded upstream and may be rejected.

## References

- `backend/src/providers/openai/codex-core.js`
