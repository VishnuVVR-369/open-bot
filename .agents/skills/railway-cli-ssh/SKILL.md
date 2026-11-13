---
name: railway-cli-ssh
description: Use when reading open-bot's Railway logs, inspecting or troubleshooting a deployed service, or running a command inside one over SSH.
---

# Railway CLI and SSH

Project: `open-bot` (`ffe4f999-838d-41fe-b21b-1703469a7039`).
Environment: `production` (`52dce811-6c4d-49ab-9db9-ef29d85510aa`).
Services: `computer`, `worker`, `web`, `pages`, `Postgres`.
SSH identity: `~/.ssh/railway_ed25519` (the private key stays on this Mac).

Pass the project and environment flags every time: commands may run outside the linked repository.
Check `railway <command> --help` when unsure of an option.

## Logs

```sh
railway logs --project ffe4f999-838d-41fe-b21b-1703469a7039 \
  --environment production --service computer --lines 100
```

Change `--service` for other services.
Bound every log request; never stream without an end.

## A command in a container

Pass the command after `--` so the session exits:

```sh
railway ssh --project ffe4f999-838d-41fe-b21b-1703469a7039 \
  --environment production --service computer \
  -i ~/.ssh/railway_ed25519 -- ps -eo pid,ppid,rss,comm --sort=-rss
```

Leave out `--` and the command only when the user wants an interactive shell.
`railway run` executes locally with the service's variables; it is not a remote shell.

## Scope

- Diagnose with reads.
  Deploys, restarts, configuration or data changes and key registration need the user to ask for them; this skill does not authorize them.
- Keep the computer's persistent `/home` volume.
- Never print environment variables wholesale, even to redact afterwards.
  Ask for specific names, or check presence only.
  Never print auth files, tokens or private keys.
- `WORKER_SECRET` and `ENCRYPTION_KEY` must match between `web` and `worker`.
- Read a service's real build and start settings from Railway before assuming them.

## Access failures

- Missing project link: pass `--project`; do not link the home directory.
- Missing key: check `railway ssh keys list`.
  If the user asks for setup, register the existing public key with `railway ssh keys add --key ~/.ssh/railway_ed25519.pub --name "Railway Mac"`.
  Never overwrite an existing key.
- Report an authentication or permission failure; do not provision a replacement.

Reference: https://docs.railway.com/cli/ssh
