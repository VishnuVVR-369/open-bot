// Credentials written as text: in a command, its output, a tool's result or a message. Each step
// below finds one way a credential is commonly written and replaces the credential, keeping the
// text around it. A secret written in none of these ways (a bare password in prose, a value under
// a name that doesn't look like a credential) is not found; see the security docs' Model logs
// section for the exact list.

/** What a redacted value is replaced with. */
export const REDACTED = "[redacted]";

/** Parts of a key (lowercased, without `_` or `-`) that mean its value is a credential. */
const SECRET_KEY_PARTS = [
  "authorization",
  "password",
  "passwd",
  "passphrase",
  "secret",
  "cookie",
  "bearer",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authtoken",
  "sessiontoken",
  "privatekey",
  "credential",
  "signature",
  "accountid",
];

/** Keys that are a credential only as a whole word: `auth` (Docker's), `pass`, `tokens`. */
const SECRET_KEYS = new Set(["auth", "pass", "tokens"]);

/** A key lowercased, without anything but letters and digits (`X-Api-Key` is `xapikey`). */
export function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Whether a key names a credential: a token, key, secret, password, cookie or account id. */
export function isSecretKey(key: string): boolean {
  const name = normalizedKey(key);
  return (
    name.endsWith("token") ||
    SECRET_KEYS.has(name) ||
    SECRET_KEY_PARTS.some((p) => name.includes(p))
  );
}

/** A credential in a key and value written as text, its value replaced when the key names one. */
function assignment(key: string, value: string, write: (value: string) => string) {
  return isSecretKey(key) ? write(REDACTED) : write(value);
}

/** A quoted part of a shell word: `'..'`, `".."`, `$'..'` or `$".."`. */
const QUOTED = String.raw`\$'(?:[^'\\\n]|\\.)*'|\$?"(?:[^"\\\n]|\\.)*"|'[^'\n]*'`;

/** A value that opens a quote and never closes it, because the string was cut inside it. */
const CUT_QUOTED = String.raw`\$'(?:[^'\\\n]|\\.)*$|\$?"(?:[^"\\\n]|\\.)*$|'[^'\n]*$`;

/**
 * A value after `key=`: quoted parts and plain characters, up to a space, `&`, `,`, `;`, or an
 * escaped quote or line end of the JSON string it is in.
 */
const VALUE = String.raw`(?:${QUOTED}|[^\s"'&,;\\]|\\(?![nrt"]))+|${CUT_QUOTED}`;

/** A shell word, as a flag's value: quoted parts and plain characters, up to a space or `;&|<>()`. */
const SHELL_WORD = String.raw`(?:${QUOTED}|[^\s"';&|<>()\\]|\\(?![nrt"]))+|${CUT_QUOTED}`;

/**
 * Where a header-like `Name: value` starts: after the start of a line (also an escaped `\n` in
 * JSON text), a quote (`"`, `'` or an escaped `\"`), or any character that can't be part of the
 * name.
 */
const HEADER_NAME =
  /(^|\\[nrt]|[^A-Za-z0-9_.\\-])(\\"|"|')?[ \t]*([A-Za-z][A-Za-z0-9_-]{0,80})[ \t]*:[ \t]*/gm;

/**
 * Where a header's value ends: at the quote it was opened with (skipping escaped quotes), or at
 * the end of its line (also an escaped `\n` or `\r`).
 */
function headerValueEnd(text: string, start: number, quote: string): number {
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "\n") return index;
    if (quote === "'") {
      if (char === "'") return index;
      continue;
    }
    if (char !== "\\" && char !== '"') continue;
    if (char === '"') {
      if (quote === '"') return index;
      continue;
    }
    const next = text[index + 1];
    if (quote === '\\"' && next === '"') return index;
    if (quote !== '"' && (next === "n" || next === "r")) return index;
    index += 1;
  }
  return text.length;
}

/**
 * The whole value of every header named like a credential (`Authorization`, `Cookie`,
 * `Set-Cookie`, `X-Api-Key`, ...) or YAML-style `password: value`: every cookie, an authorization's
 * scheme and parameters, up to the quote the header was opened with or the end of its line.
 */
function redactHeaderValues(text: string): string {
  let out = "";
  let from = 0;
  const names = new RegExp(HEADER_NAME.source, HEADER_NAME.flags);
  for (let match = names.exec(text); match; match = names.exec(text)) {
    const [whole, , quote = "", name] = match;
    const start = match.index + whole.length;
    if (!isSecretKey(name!) || text.startsWith(REDACTED, start)) continue;
    const end = headerValueEnd(text, start, quote);
    if (end === start) continue;
    out += text.slice(from, start) + REDACTED;
    from = end;
    names.lastIndex = end;
  }
  return out + text.slice(from);
}

/** Whether text looks like `.netrc` entries: `machine <host>` or `default`, then their tokens. */
const NETRC =
  /(?:^|\s|\\n)(?:machine(?:\s|\\[nt])+\S+|default)(?:\s|\\[nt])+(?:login|password|account|macdef)(?:\s|\\[nt])/;

/** A `.netrc` token's value: the login, password or account after its keyword, on any line. */
const NETRC_TOKEN =
  /(^|\s|\\[nt])(login|password|passwd|account)((?:\s|\\[nt])+)("[^"\n]*"|[^\s"\\]+)/g;

/** Strings that look like credentials wherever they appear, in the order they are applied. */
const SECRET_PATTERNS: [RegExp, (match: string, ...groups: string[]) => string][] = [
  // The model proxy's token, in a thread's provider URL.
  [/\/model-proxy\/[^/\s"']+/g, () => `/model-proxy/${REDACTED}`],
  // A PEM private key, to its end line (or the end of the text, if it was cut).
  [
    /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|(?![\s\S]))/g,
    (_, kind) => `-----BEGIN ${kind}PRIVATE KEY----- ${REDACTED}`,
  ],
  // A URL's user and password (`https://alice:secret@host`, `postgres://...`), in any scheme.
  [/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/?#"'<>\\]*@/g, (_, scheme) => `${scheme}${REDACTED}@`],
  // JWTs, like a ChatGPT access or id token.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, () => REDACTED],
  // API keys and tokens with a known prefix: OpenAI and Anthropic, Stripe, GitHub, GitLab, Slack,
  // Google, npm and AWS access keys.
  [
    /\b(?:sk-[A-Za-z0-9_-]{16,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{35}|npm_[A-Za-z0-9]{36}|(?:AKIA|ASIA)[A-Z0-9]{16})/g,
    () => REDACTED,
  ],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (_, scheme) => `${scheme} ${REDACTED}`],
  // A flag named like a credential (`--password x`, `--api-key=x`), and a user with its password
  // (`curl -u alice:secret`, `--user`, `--proxy-user`). A word starting with `-` after a space is
  // the next flag, not a value.
  [
    new RegExp(String.raw`(^|\s)(--?[A-Za-z][A-Za-z0-9-]*)(=|[ \t]+(?!-))(${SHELL_WORD})`, "gm"),
    (match, before, flag, sep, value) =>
      isSecretKey(flag) && !flag.startsWith("--no-")
        ? `${before}${flag}${sep}${REDACTED}`
        : /^(?:-u|--user|--proxy-user)$/.test(flag) && value.includes(":")
          ? `${before}${flag}${sep}${REDACTED}`
          : match,
  ],
  // Serialized JSON (`"refresh_token": "..."`), also when escaped inside another JSON string.
  [
    /"([^"\\\n]{1,100})"(\s*:\s*)"((?:[^"\\\n]|\\.)*)"/g,
    (_match, key, colon, value) => assignment(key, value, (v) => `"${key}"${colon}"${v}"`),
  ],
  [
    /\\"([^"\\\n]{1,100})\\"(\s*:\s*)\\"((?:[^"\\\n]|\\[^"\n])*)\\"/g,
    (_match, key, colon, value) => assignment(key, value, (v) => `\\"${key}\\"${colon}\\"${v}\\"`),
  ],
  [
    /'([^'\\\n]{1,100})'(\s*:\s*)'([^'\n]*)'/g,
    (_match, key, colon, value) => assignment(key, value, (v) => `'${key}'${colon}'${v}'`),
  ],
  // `key=value` and `key: value`: env files, shell (with any quoting: `'..'`, `".."`, `$'..'`),
  // YAML, query strings. An authorization scheme (`Authorization=Bearer ...`) is kept, and the
  // credential after it redacted, however short.
  [
    new RegExp(
      String.raw`(^|[^A-Za-z0-9_.-])([A-Za-z_][A-Za-z0-9_.-]{0,80})([ \t]*[=:][ \t]*)((?:Bearer|Basic|Token)[ \t]+)?(${VALUE})`,
      "gim",
    ),
    (_match, before, key, sep, scheme = "", value) =>
      assignment(key, value, (v) => `${before}${key}${sep}${scheme}${v}`),
  ],
];

/**
 * A text with every credential written in a known way replaced by `REDACTED`:
 * - the model proxy's token in its URL, PEM private keys, JWTs, API keys and tokens with a known
 *   prefix, and `Bearer` or `Basic` credentials;
 * - a URL's user and password, in any scheme;
 * - the whole value of a header named like a credential (`Authorization`, `Cookie`,
 *   `Set-Cookie`, `X-Api-Key`, ...) or of a `name: value` line, up to its quote or line end;
 * - `.netrc` entries' logins, passwords and accounts, on one line or several;
 * - flags named like a credential (`--password x`), and `-u` or `--user` with a password;
 * - a value written as JSON (also escaped in a JSON string), `key=value` (with any shell
 *   quoting) or `key: value` under a key `isSecretKey` names.
 */
export function redactSecretText(text: string): string {
  let out = redactHeaderValues(text);
  if (NETRC.test(out))
    out = out.replace(
      NETRC_TOKEN,
      (_, before, keyword, space) => `${before}${keyword}${space}${REDACTED}`,
    );
  for (const [pattern, replace] of SECRET_PATTERNS)
    out = out.replace(pattern, replace as (match: string, ...groups: unknown[]) => string);
  return out;
}
