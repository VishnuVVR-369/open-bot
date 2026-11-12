import { newRunTag, RUN_TAG } from "./stack";

/**
 * Tags the run. Everything the specs create carries the tag, and teardown only removes what does,
 * so nothing that was there before, and nothing another run is making at the same time, can match.
 */
export default function globalSetup() {
  process.env[RUN_TAG] = newRunTag();
}
