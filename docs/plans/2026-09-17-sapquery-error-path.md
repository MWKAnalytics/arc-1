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
3. Return only the authored hint from the internal classifier. Format the error once at the public
   boundary, choosing either the SAP message or a status-only prefix. No classification object,
   duplicated message construction, or delimiter parsing is needed.
4. Pass only `config.minimalErrors` from dispatch into `handleSAPQuery`. Require the boolean through
   the handler/classifier chain so omitted wiring is a compile error, without passing an unrelated
   `ServerConfig` object.
5. Update the concise LLM-facing tool description and regenerate the five affected snapshots.
6. Add focused tests for 255 vs. 256, specific-classifier priority, chunked requests, normal
   disclosure, minimal disclosure, and handler/dispatch-level redaction.
7. Run focused tests, typecheck, lint, schema/size gates, the full unit suite, and live before/after
   checks on 7.58 and 8.16. Review the final diff again for disclosure leaks and inaccurate universal
   claims; fix and repeat until clean.

## Plan review

- **Safety:** no new endpoint or capability; `OperationType.FreeSQL`, SQL scope, blocklist checks,
  response budgets, and audit flow remain untouched.
- **Compatibility:** post-error classification cannot block a backend that accepts longer SQL.
- **Disclosure:** the authored hint is safe; the SAP message, response body, and ADT path stay on the
  non-minimal branch only.
- **Complexity:** both the internal hint and external display APIs use `string | undefined`. One
  formatting boundary handles disclosure without wrappers around every classifier return.
- **Testability:** focused classifier tests cover branch decisions; handler and dispatch tests prove
  the result path receives the flag, including when SAP text itself contains a `Hint:` delimiter.
- **Documentation accuracy:** wording must say “some older backends,” not “ADT” universally, because
  8.16 disproves the unconditional statement.
