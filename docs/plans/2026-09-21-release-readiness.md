# Release readiness and hold — #811

Durable record carried by main-bound #813. Do not publish #811 before #813, #809 and #828
merge, release-please regenerates the candidate, and its notes and validation are reconciled.
Include #678's callback migration guidance if it also lands before the release.

## Candidate and regeneration

On 2026-09-21, #811 regenerated as **1.4.0** at `bec5a60f` after #829 merged. Its changelog
contains #829 (extension report execution) and #807 (Connectivity session reuse). #813, #809,
#828 and #678 are not yet included. The old 1.3.1 plan and release-note commits were discarded.
Always read the current candidate; its version and contents can change again.

release-please rebuilds its branch from `main` with `force: true`
([implementation](https://github.com/googleapis/release-please/blob/v17.6.0/src/github.ts)).
Keep annotations on a main-bound PR. The release PR body is only a convenient pointer to this
hold, and can also be overwritten. The release-notes guard checks versions, not missing rows.

## Before publishing

1. Merge the required fixes and let release-please regenerate #811 from the resulting `main`.
2. Reconcile one release-note section with the generated version and merged changes. #813 seeds
   the 1.4.0 rows for #829, #807 and #813; add #809 and #828, and #678 if included.
3. Replace `(unreleased)` with the release date and validate the resulting candidate: unit tests,
   typecheck, build, lint, policy, size/schema budgets, MTA validation, strict docs and packed-npm
   smoke. Earlier branch results do not validate the regenerated candidate.
4. Do not use `workflow_dispatch` on `release.yml` to refresh the PR: it also runs `publish-npm`.

Roadmap: no impact; this is release preparation for existing changes.
