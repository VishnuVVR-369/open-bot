## Summary

What changed and why.

## Verified

Commands run, and how a new test or guard was shown to fail without the change.

## Not verified

What was skipped, run only against stand-ins or an emulator, or still needs a device or a deploy.

## Deploy impact

Which Railway services redeploy (`.railway/watch-paths.ts`), and anything to do between migration and deploy; or "none".

## Docs and guardrails

- [ ] A recipe this changes is updated: the root `AGENTS.md` ("Where to make common changes") or the workspace `AGENTS.md` that owns it
- [ ] Behavior this changes is updated in its architecture or flow page under `apps/site/src/app/docs`
- [ ] The "Verification" check map in the root `AGENTS.md` still names the right checks
- [ ] A new environment variable is in `apps/site/src/app/docs/reference/configuration/page.mdx` and `.env.example`
- [ ] Baselines only shrank (`scripts/check/*-baseline.json`), or the growth is explained above
