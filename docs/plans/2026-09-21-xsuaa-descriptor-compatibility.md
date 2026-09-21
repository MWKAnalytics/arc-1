# XSUAA descriptor compatibility — #812 / #813

## Root cause and evidence

The descriptor still registers IDE callback patterns directly with XSUAA. Since the
callback proxy (#325), `startHttpServer` passes ARC-1's own `/oauth/callback` URL to
`createXsuaaOAuthProvider`. The provider uses that URL for both authorization and token
exchange. The IDE URL travels in signed state and is checked by the client store on return.
These are separate allowlists; the XSUAA descriptor does not control the final IDE redirect.

The reporter reproduced broker rejection of three `cursor://` / `vscode://` patterns on
eu10-004, and successful service creation after removing them. That demonstrates the
reported environment, not when or whether every region changed its validation.

SAP's [descriptor reference](https://help.sap.com/docs/btp/sap-business-technology-platform/application-security-descriptor-configuration-syntax)
defines upstream OAuth-client configuration. Its [invalid-redirect troubleshooting](https://help.sap.com/docs/authorization-and-trust-management-service/authorization-and-trust-management/invalid-redirect-uri?version=Cloud)
requires applying the complete descriptor on update. Neither source proves the reported
rollout date; retain the live report as the evidence for this broker error.

## Plan

1. Keep the three-line descriptor removal. No new config flag, URL matcher, auth-library
   change, or fallback is needed. Broader callback restriction belongs to #678.
2. Add a regression preventing non-HTTP(S) upstream callbacks. Exercise the actual OAuth
   provider and callback handler with Cursor and VS Code callbacks, for registered and
   manual clients: XSUAA must receive the server callback and the IDE must receive its
   original state and authorization code only after client-binding validation.
3. Tighten operator instructions: rebuild/redeploy MTA installations; update the complete
   landscape descriptor for manually managed XSUAA. Do not promise universal IDE success
   from a descriptor-only change or replace unrelated operator settings.
4. Reproduce the old descriptor failure and corrected create/update using an isolated,
   unbound XSUAA service if CF access is available; remove only that test service afterward.
5. Run focused auth/descriptor/release-note tests, typecheck, lint, policy/build/size gates,
   MTA validation and strict docs. Review the final diff and push additive commits to #813.

## Validation record

- CF us10-001 / abap-dev initially refused service listing because the saved session had
  expired. A login attempt with the configured account failed. A session refresh is
  requested; no existing service, binding, app, role or destination was changed.
- After the session was refreshed, reproduced both create and update on CF us10-001,
  XSUAA application plan, on 2026-09-21. The original descriptor (only xsappname isolated)
  failed with the three reported malformed URI patterns. The corrected descriptor created
  successfully. Updating that disposable instance with the original patterns failed;
  applying the corrected complete descriptor succeeded. Both instances were unbound and
  deleted after verification; no service key or role assignment was needed.
- The descriptor regression fails with the original file and passes with the fix.
  All 48 focused callback/descriptor/release-note/BTP-doc/AppRouter tests pass, including
  six provider-to-callback IDE round trips (three URIs × manual/DCR).
- Typecheck, build, lint (two existing informational notices), policy validation, file/tool
  budgets, all five MTA validation combinations and strict MkDocs pass.
- Review kept the original minimal descriptor change. Added compatibility proof and
  corrected the operator action rather than adding any new runtime mechanism.
- Limits: broker create/update and local provider/callback behavior are verified; an
  installed IDE login/token exchange and full MTA deployment were not run for this patch.

## Roadmap

No roadmap impact. This repairs the deployment descriptor; SEC-15 and SEC-16 concern
different OAuth lifecycle/client-identification work. Rechecked the current roadmap.
