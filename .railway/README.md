# Railway configuration

`railway.ts` describes the open-bot Railway project (the `production` environment): every service's build, start, health check, replicas, volumes and watch paths.
Variables are not managed here; they stay on Railway.
Railway does not read this folder during deploys; a change here takes effect when the `Railway apply` workflow applies it after merge.

## Watch paths

A push to `main` redeploys a service only when it changes a file matching that service's watch paths.
`watch-paths.ts` lists the folders each service builds from, and `watch-paths.test.ts` (run by `pnpm test`) fails when a list no longer matches the workspace dependency graph or the computer's Dockerfile.
When a service gains a workspace dependency, add the package's folder to its list in the same PR.

A push that matches no service, such as a docs-only change, deploys nothing.
To ship a variable change or retry a deploy, redeploy the service from Railway.

## Changing the project

Change it through a pull request:

1. A PR that touches `.railway/` runs the `Railway plan` workflow, which comments the plan on the PR.
   Check that it lists exactly the changes you meant.
2. Merging runs the `Railway apply` workflow, which applies that same pinned plan.
   It never plans again, so `main` and Railway end up identical.

Apply fails, by design, when:

- production changed after the plan (a dashboard edit or another apply): push to the PR, or reopen it, to plan again;
- `.railway/` on `main` differs from what was planned, for example after a conflict resolution: plan it again in a new PR;
- the plan would delete something (a service, volume or database): review it, then apply by hand.

Both workflows use the `RAILWAY_TOKEN` repository secret, a Railway project token for the `production` environment.

To plan locally, or to apply by hand, link the checkout once and run from the repo root:

```sh
railway link --project ffe4f999-838d-41fe-b21b-1703469a7039 --environment production
railway config plan
railway config apply
```

`plan` only reads.
A dashboard edit to a setting defined here is undone by the next apply, so make the change in `railway.ts` instead.
