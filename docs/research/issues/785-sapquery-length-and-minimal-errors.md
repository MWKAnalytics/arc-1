# Issue #785 — SAPQuery legacy length truncation and minimal-error leak (VALIDATED)

**Status:** Both defects confirmed independently and the fix validated on 2026-09-17. The reported
255/256 boundary is release-dependent: it reproduces on SAP_BASIS 7.58, while 8.16 accepts statements
of at least 2,048 characters. The disclosure-control defect reproduced on the pre-fix `main` path.

## TL;DR

- Some older ADT freestyle-query handlers truncate the request body to 255 characters before parsing
  it. A valid 255-character `SELECT` succeeds on 7.58; the same statement with one extra character is
  parsed as if the final character were missing. SAP then reports a misleading error about that
  fragment.
- The limit is not universal. The same 8.16 endpoint accepts 256-, 512-, and 2,048-character
  statements. ARC-1 must therefore explain the limit only after a matching parser rejection; it must
  not reject long statements before sending them or advertise 255 as an unconditional maximum.
- `handleSAPQuery` converts classified parser exceptions into `ToolResult` errors. That early return
  bypasses `dispatch.ts`'s `ARC1_MINIMAL_ERRORS` formatter, exposing the SAP diagnostic and ADT path.
- The fix should preserve the ARC-1-authored remediation hint while replacing the error prefix with
  status-only text when minimal errors are enabled.

## Claim and current HEAD

The report describes two defects in `SAPQuery`:

1. a valid freestyle statement longer than 255 characters can be truncated by SAP and receive the
   generic ARC-1 parser advice; and
2. classified parser errors ignore `ARC1_MINIMAL_ERRORS`.

Current HEAD confirms the control-flow precondition for both:

- `src/handlers/query.ts` calls `classifySapQueryParserError()` and immediately returns its string as
  an error result;
- `src/handlers/query-errors.ts` prefixes every hint with `err.message`, which includes SAP's text and
  the request path; and
- only exceptions that reach `buildBaseErrorMessage()` in `src/handlers/dispatch.ts` use
  `formatMinimalAdtError()`.

## Live validation

The probe used a valid statement padded with spaces so its final token ended exactly at the boundary:

```text
SELECT mandt <padding> AS A FROM t000
```

The body was posted directly as `text/plain` to
`/sap/bc/adt/datapreview/freestyle?rowNumber=1` after fetching a CSRF token. Product-path checks used
`arc1 call SAPQuery` with free SQL enabled.

| System | Length | Result | Decisive evidence |
|---|---:|---|---|
| S/4HANA 2023, SAP_BASIS 7.58 | 255 | 200 | Returned column `A`; executed query contains `FROM T000` |
| S/4HANA 2023, SAP_BASIS 7.58 | 256 | 400 | SAP returns `Cannot find 'T00'` with T100 `ADT_DATAPREVIEW_MSG/022` |
| ABAP Platform 2025, SAP_BASIS 8.16 | 256 | 200 | Returned column `A` |
| ABAP Platform 2025, SAP_BASIS 8.16 | 512 | 200 | Returned column `A` |
| ABAP Platform 2025, SAP_BASIS 8.16 | 2,048 | 200 | Returned column `A` |
| NW 7.50 SP02 test system | 255/256 | not testable | Endpoint is in discovery but returns 404 `No suitable resource found` for every POST |

The 7.58 error is direct evidence of pre-parse truncation: the only lost byte is the final `0` in
`T000`, and SAP reports the resulting `T00` token. This independently validates the reporter's 7.50
SP23 observation while broadening the affected range. The available 7.50 SP02 system is too old or
incompletely configured to execute the endpoint, so it cannot independently confirm that exact
support-package level.

For the disclosure defect, this invalid sort syntax was submitted through current HEAD on 7.58:

```text
SELECT mandt FROM t000 ORDER BY mandt DESC
```

With both `ARC1_MINIMAL_ERRORS=false` and `true`, the returned tool result contained:

```text
ADT API error: status 400 at /sap/bc/adt/datapreview/freestyle?rowNumber=1:
"DESC" is not allowed here. "." is expected.
```

The ARC-1 hint was also present. An unclassified exception in the same dispatch path is reduced to a
status-only message, so the differing disclosure is an ARC-1 bug rather than backend behavior.

## Contract and reference checks

- Live ADT discovery publishes a POST collection at `/sap/bc/adt/datapreview/freestyle` with the
  `rowNumber` template parameter. ARC-1 uses that contract with `Content-Type: text/plain` in
  `AdtClient.postDataPreview()`.
- The local Eclipse ADT contract inventory (`api/21-data-preview-and-query.md`) identifies the same
  endpoint but explicitly has no bytecode evidence for a universal statement-length maximum.
- The fr0ster reference repository's captured discovery documents the same collection plus
  check/pretty-printer templates; it does not impose a client-side 255-character limit.
- SAP's SQL Console documentation says the console accepts ABAP SQL and exposes Max Rows separately;
  it does not document a 255-character cross-release maximum. No relevant SAP Note/KBA for this
  exact truncation was found in the available official search results.

These checks support a release-adaptive, post-error hint rather than a client-side validation rule.

## Root cause

### Legacy statement truncation

The 7.58 handler passes only the first 255 characters of the text body into its parser. The parser
then diagnoses the truncated fragment, so the message can name a missing table, an unrelated token,
or claim that only one `SELECT` is allowed. The exact server implementation is proprietary and is
not exposed by the checked Eclipse client artifacts, but the byte-identical boundary response proves
where the semantic corruption occurs. The handler was changed by 8.16 to accept longer input.

### Minimal-error bypass

This root cause is wholly inside ARC-1. Classified parser errors are deliberately returned as tool
results to give targeted dialect guidance. Result-path errors do not enter dispatch's exception
formatter, so the classifier must apply the same client-disclosure control before it returns.

## Fix scope

- `src/handlers/query-errors.ts`: add a length-aware generic fallback after every more-specific
  classifier; keep chunked retries out of that fallback; format classified errors from a safe base
  under minimal mode.
- `src/handlers/query.ts` and `src/handlers/dispatch.ts`: pass the minimal-error flag to the result
  path without coupling the handler to unrelated configuration.
- `src/handlers/tools.ts` and tool-definition fixtures: tell callers that *some older* backends have
  the limit, without claiming that 8.16 does.
- `tests/unit/handlers/query-errors.test.ts`: pin the 255/256 boundary, priority, chunking exception,
  and redaction on/off through both classifier and handler.

No tool schema changes, authorization changes, ADT endpoints, or mutations are involved.

## Implementation validation

The completed implementation keeps the legacy-length advice behind SAP's parser rejection, preserves
all more-specific dialect classifiers, and skips the advice when ARC-1 sent generated IN-list chunks.
The internal classification carries the authored hint separately from the full SAP error, so minimal
mode formats a status-only prefix without parsing or slicing untrusted error text.

Live product-path verification after the fix:

- 7.58, 512 characters, normal mode: raw SAP grammar message plus the new legacy truncation hint;
- 7.58, 512 characters, minimal mode: `ADT API error: status 400.` plus the same hint, with no SAP
  diagnostic or ADT path; and
- 8.16, 512 characters: successful query execution, proving that ARC-1 added no preflight ceiling.

Repository gates passed: typecheck, lint (one pre-existing informational suggestion outside this
change), policy validation, schema/file-size budgets, 196 focused tests, and the complete 6,793-test
unit suite.

## Draft response

```markdown
Confirmed independently, with one important scope correction.

On SAP_BASIS 7.58, a valid 255-character freestyle `SELECT` succeeds, while the same body at 256
characters is truncated before parsing: `T000` becomes `T00`, and SAP returns `Cannot find 'T00'`.
On SAP_BASIS 8.16, the endpoint accepts the same query at 256, 512, and 2,048 characters. The fix
therefore needs to be post-hoc and release-neutral: explain the legacy 255-character truncation only
after SAP rejects a longer statement, never reject it before sending and never advertise 255 as a
universal maximum.

The `ARC1_MINIMAL_ERRORS` report is also confirmed. Classified SAPQuery failures return directly as
tool results, bypassing dispatch's exception redaction, so both the SAP text and ADT path currently
leak in minimal mode. The targeted fix keeps ARC-1's safe remediation hint but replaces the raw error
prefix with status-only text.

The available NW 7.50 SP02 test system cannot execute this endpoint (`404 No suitable resource
found`), so it cannot independently re-check the reporter's SP23 systems. The exact truncation on
7.58 and its absence on 8.16 nevertheless establish both the mechanism and the required adaptive
behavior.
```
