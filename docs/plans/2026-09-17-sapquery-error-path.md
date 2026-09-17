# SAPQuery legacy length and minimal-error fix plan

## Goal

Correct two result-path defects without adding preflight rejection, release tables, or a second error
framework:

1. explain likely 255-character truncation when an older backend has already rejected a longer
   statement with a parser signature; and
2. honor `ARC1_MINIMAL_ERRORS` for classified parser failures.

Evidence and release behavior are recorded in
`docs/research/issues/785-sapquery-length-and-minimal-errors.md`.

## Plan

1. Keep every existing syntax-specific classifier ahead of the length fallback. The length advice
   applies only to otherwise-generic parser failures and only when ARC-1 sent the original statement,
   not a generated IN-list chunk.
2. Describe 255 as a legacy/backend-dependent boundary. Do not reject before POST; live 8.16 accepts
   at least 2,048 characters.
3. Make the internal classifier carry the authored hint separately from its full display message.
   Minimal mode can then format `status + hint` directly, without parsing a previously formatted
   string or risking SAP text crossing the boundary.
4. Pass only `config.minimalErrors` from dispatch into `handleSAPQuery`; keep the handler's default
   false so direct callers and existing tests do not need an unrelated `ServerConfig` object.
5. Update the concise LLM-facing tool description and regenerate the five affected snapshots.
6. Add focused tests for 255 vs. 256, specific-classifier priority, chunked requests, normal
   disclosure, minimal disclosure, and handler-level redaction.
7. Run focused tests, typecheck, lint, schema/size gates, the full unit suite, and live before/after
   checks on 7.58 and 8.16. Review the final diff again for disclosure leaks and inaccurate universal
   claims; fix and repeat until clean.

## Plan review

- **Safety:** no new endpoint or capability; `OperationType.FreeSQL`, SQL scope, blocklist checks,
  response budgets, and audit flow remain untouched.
- **Compatibility:** post-error classification cannot block a backend that accepts longer SQL.
- **Disclosure:** the authored hint is safe; the SAP message, response body, and ADT path stay on the
  non-minimal branch only.
- **Complexity:** a two-field internal classification avoids separator-based string surgery while
  preserving the existing external `string | undefined` API.
- **Testability:** all new decisions are pure classifier branches; one handler test proves the result
  path actually receives the flag.
- **Documentation accuracy:** wording must say “some older backends,” not “ADT” universally, because
  8.16 disproves the unconditional statement.
