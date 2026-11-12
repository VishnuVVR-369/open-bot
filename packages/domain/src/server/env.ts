import { z } from "zod";

/**
 * An optional setting where set but empty counts as unset, so a blank line in a `.env` file or a
 * blank variable on the host means the default.
 */
export function unsetIfEmpty<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === "" ? undefined : value), schema.optional());
}

/**
 * Parses an app's environment with its schema, or throws one readable line naming every
 * variable that is missing or invalid (never their values).
 */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined>,
): z.output<T> {
  const parsed = schema.safeParse(source);
  if (parsed.success) return parsed.data;
  throw new Error(
    parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; "),
  );
}
