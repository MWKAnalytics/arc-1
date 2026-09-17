# PR #785 — SAPQuery legacy length hint and minimal-error control

**Final verdict:** APPROVE after maintainer follow-up.

The original contribution identified two real defects and chose the correct high-level strategy:
post-error explanation rather than preflight rejection, plus local redaction for the result path that
bypasses dispatch. Independent live review found one blocking accuracy issue in the first revision:
it described 255 characters as a universal ADT maximum. SAP_BASIS 8.16 accepts at least 2,048
characters. The continued PR now scopes the behavior to some older backends and keeps it post-hoc.

## Continuation decision

The existing PR was suitable to continue rather than replace:

- state `OPEN`, not draft;
- mergeable with `maintainerCanModify=true`;
- one focused contributor commit by Marvin Kloth (`53a9dc42`);
- no unrelated scope or unsafe endpoint changes; and
- current `main` merged cleanly without rewriting the contributor's history.

The final branch preserves the original authored commit and adds the maintainer merge/follow-up.

## Independent evidence

| Check | Result |
|---|---|
| 7.58 direct POST, 255 characters | 200; `FROM T000` executed |
| 7.58 direct POST, 256 characters | 400; SAP parsed the truncated `T00` token |
| 8.16 direct POST, 256/512/2,048 characters | 200 for all three |
| Pre-fix 7.58 classified error with minimal mode | leaked SAP diagnostic and ADT path |
| Post-fix 7.58, 512 characters, normal mode | raw error plus length-specific hint |
| Post-fix 7.58, 512 characters, minimal mode | status-only error plus safe hint |
| Post-fix 8.16, 512 characters | succeeds; no client-side ceiling |

The available NW 7.50 SP02 system returns `404 No suitable resource found` for the published
freestyle collection, so it cannot independently rerun the contributor's 7.50 SP23 measurement.

## Review findings and resolution

### Resolved blocker — universal maximum claim

The first revision's constant comment, hint, and tool description said ADT parses at most 255
characters. Live 8.16 disproves that. The final text consistently says “some older ADT backends,” and
the classifier only runs after SAP has already rejected a longer statement.

### Resolved maintainability concern — redaction by delimiter parsing

The first revision constructed a full error string and then used `lastIndexOf("\\n\\nHint: ")` to
recover the authored hint for minimal mode. The final classifier carries `{ message, hint }`
internally and selects the safe rendering directly. Untrusted SAP text is never parsed to establish
the disclosure boundary.

### Test quality improvement

The boundary fixture now creates valid SQL at both 255 and 256 characters by changing only optional
whitespace. Tests also pin that specific dialect advice wins over the length fallback and that
chunk-generated failures do not blame the caller's original length.

## Security and architecture review

- Existing `OperationType.FreeSQL`, SQL scope, data-source policy, response budget, and audit pipeline
  are unchanged.
- No endpoint, HTTP verb, media type, authorization policy, schema field, or write path changed.
- Minimal mode returns only the HTTP status and ARC-1-authored text; SAP's diagnostic, response body,
  and ADT path remain excluded.
- Normal mode retains existing diagnostic behavior.
- Unknown-column and table-not-found branches retain their caller/data-derived safe messages and
  unclassified exceptions still pass through dispatch's central formatter.
- Tool-definition snapshots were regenerated; all schema and size budgets remain within their
  ratchets.

## Verification

```text
npm run typecheck                                  PASS
npm run lint                                       PASS (one unrelated pre-existing info)
npm run validate:policy                            PASS, 128 entries / 14 schemas
npm run check:sizes                                PASS
npm run build                                      PASS
npm run docs:build                                 PASS (upstream MkDocs 2 advisory only)
focused handler/schema/registry tests              PASS, 196 tests
npm test                                           PASS, 219 files / 6,793 tests
git diff --check origin/main                       PASS
live SAP_BASIS 7.58 and 8.16 product-path checks   PASS
```

## Paste-able final review

```markdown
APPROVE — both defects are confirmed and the revised implementation matches the cross-release
behavior.

Independent live checks found the exact 255/256 truncation boundary on SAP_BASIS 7.58, while 8.16
accepted 256-, 512-, and 2,048-character statements. The final wording correctly scopes the limit to
some older backends and keeps the behavior post-hoc, so newer systems are never blocked.

The `ARC1_MINIMAL_ERRORS` leak is also fixed on the actual result path: minimal mode keeps the
ARC-1-authored remediation but removes SAP's diagnostic and the ADT path. The internal structured
classification avoids deriving the safe boundary by splitting untrusted error text.

Verification: typecheck, lint, policy and schema-size gates pass; 196 focused tests and all 6,793 unit
tests pass; live before/after checks pass on 7.58 and 8.16. No security or architectural blockers
remain.
```
