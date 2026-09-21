# XSUAA descriptor compatibility — #812 / #813

## Root cause

`xs-security.json` registered three IDE deep-link patterns (`cursor://…`, `vscode://…`) in
`oauth2-configuration.redirect-uris`. XSUAA parses that list when the service instance is
created or updated and rejects the **whole descriptor** over them
(`Malformed redirect URIs detected`), so a fresh BTP deployment fails at its first step.

The entries have had no effect since the `/oauth/callback` proxy (#325). `startHttpServer`
passes ARC-1's own callback URL to `createXsuaaOAuthProvider`, and the provider uses that URL
as `redirect_uri` for both `/authorize` and the token exchange
(`@arc-mcp/xsuaa-auth` `oauth-provider.js`: `redirect_uri: this.callbackUrl`). The client's
real redirect URI travels in signed state and is checked by the client store against
`XSUAA_DEFAULT_REDIRECT_URI_PATTERNS`. Two separate allowlists; the descriptor never gated the
IDE redirect.

SAP's [descriptor reference](https://help.sap.com/docs/btp/sap-business-technology-platform/application-security-descriptor-configuration-syntax)
and the [invalid-redirect troubleshooting page](https://help.sap.com/docs/authorization-and-trust-management-service/authorization-and-trust-management/invalid-redirect-uri?version=Cloud)
document the upstream OAuth-client configuration and require applying the complete descriptor
on update; neither states when the scheme validation tightened. The live broker error is the
evidence. The same doc/contract mismatch is filed upstream as arc-mcp/xsuaa-auth#72.

## Change

1. Drop the three lines from `xs-security.json`. No config flag, URL matcher, auth-library
   change or fallback. Broader callback restriction belongs to #678.
2. Regression in `tests/unit/server/mta-descriptor.test.ts`: the shipped descriptor carries
   HTTP(S) redirect URIs only, and the runtime allowlist ARC-1 validates against still carries
   the IDE schemes (the pair is what makes the removal safe).
3. Operator guidance in `docs_page/xsuaa-setup.md`: MTA installations rebuild and redeploy;
   manually managed XSUAA edits its **complete landscape descriptor** and keeps its other
   settings. A descriptor-only change is not promised to fix every IDE login.

Rejected during review: a six-case provider→callback round trip over the IDE schemes. It
exercised only `@arc-mcp/xsuaa-auth`'s default pattern constants through a locally built
provider, so no change in this repository could fail it, and #678 covers the same round trip
through the real `startHttpServer` with ARC-1's own allowlist. Replaced by the two-line
allowlist assertion above (−55 lines).

## Validation

- **Live broker, CF `us10-001` / `abap-dev`, 2026-09-21** (disposable unbound instances,
  XSUAA `application` plan, only `xsappname` changed):
  `cf create-service` with the original descriptor → `create failed`,
  `Malformed redirect URIs detected. The following URIs are invalid:
  [cursor://anysphere.cursor-retrieval/**, cursor://anysphere.cursor-mcp/**,
  vscode://vscode.microsoft-authentication/**]`. The corrected descriptor →
  `create succeeded`. Both instances deleted afterwards; no binding, key, app, role or
  destination was touched. The reporter's independent eu10-004 evidence agrees.
- The descriptor regression fails against `origin/main`'s `xs-security.json` and passes with
  the fix. Focused callback/descriptor tests pass; full `npm test`, typecheck, build, lint,
  `validate:policy`, `check:sizes`, `mbt` MTA validation and strict MkDocs pass.
- **Not covered:** an installed Cursor/VS Code login and token exchange against an instance
  created without the entries, and a full MTA deployment. The IDE conclusion rests on the
  callback-proxy code path, not an IDE session.

## Release notes

The 1.3.1 section is seeded here, on a main-bound PR, rather than on the release-please branch:
release-please rebuilds that branch from main with `force: true`
(`GitHub.updatePullRequest` → code-suggester), so an annotation committed there is discarded the
next time a `fix:` merges and the changelog changes. The section therefore also carries the #807
row that #811 currently holds on its own branch. Later fixes in this release add rows to the same
section.

## Roadmap

No roadmap impact. This repairs the deployment descriptor; SEC-15 and SEC-16 are separate
OAuth lifecycle / client-identification ideas.
