---
name: railway-cli-ssh
description: Access open-bot on Railway using the CLI and SSH for logs, resource inspection, troubleshooting, and explicitly requested operations.
---

# Railway CLI and SSH

Project: `open-bot` (`ffe4f999-838d-41fe-b21b-1703469a7039`).
Environment: `production` (`52dce811-6c4d-49ab-9db9-ef29d85510aa`).
Services: `computer`, `worker`, `web`, `pages`, `Postgres`.
Local SSH identity: `~/.ssh/railway_ed25519` (private key stays on this Mac).

Use explicit project/environment flags: commands may run outside the linked
repository. If the user specifies another project or environment, use that
instead. Check `railway <command> --help` when unsure of supported options.

## CLI

```sh
railway --version
railway whoami --json
railway logs --project ffe4f999-838d-41fe-b21b-1703469a7039 \
  --environment production --service computer --lines 100
```

Change `--service` for other services. Bound log requests rather than streaming
indefinitely. CLI operations run on the local Mac; use SSH for container commands.

## SSH

For agent execution, pass a command after `--` so the session exits:

```sh
railway ssh --project ffe4f999-838d-41fe-b21b-1703469a7039 \
  --environment production --service computer \
  -i ~/.ssh/railway_ed25519 -- ps -eo pid,ppid,rss,comm --sort=-rss
```

Omit `--` and the remote command only when the user wants an interactive shell.
`railway run` executes locally with service variables; it is not a remote shell.
Railway SSH needs no public domain, exposed port 22, or container SSH daemon.

## Access failures and scope

- Missing project link: supply `--project`; do not link the home directory.
- Missing key: inspect `railway ssh keys list`. If setup is requested, register
  the existing public key with `railway ssh keys add --key ~/.ssh/railway_ed25519.pub
--name "Railway Mac"`. Never overwrite an existing key or expose its contents.
- `ssh openbot-computer` works only after a successful `railway ssh config`
  command created that alias. Prefer the explicit CLI command above.
- Diagnose with reads. Deploys, restarts, configuration/data changes and key
  registration must be within the user's requested scope; this skill alone
  does not authorize them. Preserve the computer's persistent `/home` volume.
- Never print environment variables wholesale, even to redact afterwards. Ask
  for specific names, or check presence only. Avoid printing auth files, tokens
  or private keys. Report authentication/permission failures without
  provisioning a replacement.

## Deploys

- Merging to `main` deploys `web`, `worker`, `computer` and `pages`. The
  worker's pre-deploy step runs DB migrations; if it fails, Railway keeps the
  old commit.
- `WORKER_SECRET` and `ENCRYPTION_KEY` must match between `web` and `worker`.
- Read a service's real build and start settings from Railway before assuming
  them.

Reference: https://docs.railway.com/cli/ssh
