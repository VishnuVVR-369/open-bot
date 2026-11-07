# Railway configuration

`railway.ts` describes the open-bot Railway project (the `production` environment): every service's build, start, health check, replicas, volumes and watch paths.
Variables are not managed here; they stay on Railway.
Railway does not read this folder during deploys, so a change here does nothing until it is applied.

## Watch paths

A push to `main` redeploys a service only when it changes a file matching that service's watch paths.
`watch-paths.ts` lists the folders each service builds from, and `watch-paths.test.ts` (run by `pnpm test`) fails when a list no longer matches the workspace dependency graph or the computer's Dockerfile.
When a service gains a workspace dependency, add the package's folder to its list, then apply.

A push that matches no service, such as a docs-only change, deploys nothing.
To ship a variable change or retry a deploy, redeploy the service from Railway.

## Changing the project

Link the checkout once, then plan and apply from the repo root:

```sh
railway link --project ffe4f999-838d-41fe-b21b-1703469a7039 --environment production
railway config plan
railway config apply
```

`plan` only reads.
Check that it lists exactly the changes you made before applying, and apply after the change is merged, so `main` and Railway agree.
A dashboard edit to a setting defined here is undone by the next apply, so make the change in `railway.ts` instead.
