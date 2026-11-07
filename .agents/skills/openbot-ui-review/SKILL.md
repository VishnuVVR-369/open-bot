---
name: openbot-ui-review
description: Use for open-bot UI changes that need screenshots, demo data, or a design review (including council UI rounds) across web and mobile.
---

# open-bot UI review

## Demo data

- Use the showcase stack in `tools/showcase/README.md`, never the owner's data. It runs web on :3200 and pages on :3401 against its own `openbot_showcase` database.
- `apps/site` dev also uses port 3200. Don't run both at once.
- Reseeding changes IDs. Look IDs up when capturing; never hard-code them.
- Set the timezone the showcase expects (`TZ=America/Los_Angeles`, also on the emulator) and restore it afterwards.

## Screenshots

- Before anyone reviews a set, open each image and drop any that show an error, a spinner, or a lock screen.
- Record which commit the set was taken from. Never mix sets from different commits in one review.
- Cover light and dark, and phone portrait and landscape for mobile.
- Keep images small (under about 0.8 MB) so reviewers can load them all.

## House style

- Status colors mean one thing everywhere: amber = needs you, blue = working, gray = idle or offline, red = error. Reuse the shared status helpers instead of new wording.
- Sentence case. Plain words, no internals like "worker restarted" or "pnpm dev".
