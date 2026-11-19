import { errorMessage } from "../logger";

/**
 * Whether a call to Codex's file API (`fs/*`) failed because the path isn't there. Codex answers
 * with the operating system's own message, as a JSON-RPC internal error: a missing path is
 * "No such file or directory (os error 2)". Anything else (a file where a folder was expected,
 * permission denied, a timeout, a method Codex doesn't know) is a real failure.
 */
export function isMissingPath(error: unknown): boolean {
  return /no such file or directory/i.test(errorMessage(error));
}
