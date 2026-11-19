import { describe, expect, it } from "vitest";
import { isSecretKey, REDACTED, redactSecretText } from "./secret-text";

/** A text, the secrets it holds, and what must still be readable after redaction. */
type Case = [text: string, secrets: string[], kept: string[]];

function check(cases: Case[]) {
  for (const [text, secrets, kept] of cases) {
    const out = redactSecretText(text);
    for (const secret of secrets) expect(out, `${text} -> ${out}`).not.toContain(secret);
    for (const part of kept) expect(out, `${text} -> ${out}`).toContain(part);
  }
}

describe("redactSecretText", () => {
  it("redacts shell assignments with any quoting", () => {
    check([
      ["export API_TOKEN=$'opaque-password'", ["opaque-password"], ["export API_TOKEN="]],
      ["export API_TOKEN=$'it\\'s opaque'", ["opaque"], ["export API_TOKEN="]],
      ["export API_TOKEN='opaque password'", ["opaque", "password'"], ["export API_TOKEN="]],
      ['export API_TOKEN="opaque \\"quoted\\" pw"', ["opaque", "quoted", "pw"], []],
      ['API_TOKEN=$"opaque-locale" make', ["opaque-locale"], [" make"]],
      ["PGPASSWORD=opaque-pg psql -h db", ["opaque-pg"], ["psql -h db"]],
      ["AUTHORIZATION=Bearer short1 make", ["short1"], ["Bearer", " make"]],
      // Cut off inside its quote, at the end of the stored string.
      ["DB_PASSWORD='opaque-cut", ["opaque-cut"], ["DB_PASSWORD="]],
      // The quote that closes the text around it is kept.
      [`echo "SECRET_KEY=opaque-k" > .x`, ["opaque-k"], ['" > .x']],
    ]);
  });

  it("redacts .netrc entries on one line or several", () => {
    check([
      ["machine api.example login ava password opaque1", ["ava", "opaque1"], ["api.example"]],
      [
        "machine api.example\n  login ava\n  password opaque2\nmachine b.example login bo password opaque3",
        ["ava", "opaque2", "bo", "opaque3"],
        ["machine api.example", "machine b.example"],
      ],
      ["default\n\tlogin anon\n\tpassword opaque4\n\taccount opaque5", ["opaque4", "opaque5"], []],
      // Escaped in a JSON string, as a tool's result often is.
      ["machine x.test\\n login ava\\n password opaque6\\n", ["opaque6"], ["machine x.test"]],
      // A GitHub token used as the login.
      ["machine github.com login opaque-gh-login password x-oauth-basic", ["opaque-gh-login"], []],
    ]);
    // Prose that merely mentions a password is left alone.
    expect(redactSecretText("Log in, then change your password soon.")).toBe(
      "Log in, then change your password soon.",
    );
  });

  it("redacts a URL's user and password in any scheme", () => {
    check([
      ["https://alice:opaque-password@example.test/x", ["alice", "opaque-password"], ["/x"]],
      ["postgres://app:opaque-pg@db:5432/app", ["opaque-pg"], ["@db:5432/app"]],
      ["git clone https://opaque-token@github.com/o/r.git", ["opaque-token"], ["github.com/o/r"]],
      ["redis://:opaque-redis@cache:6379", ["opaque-redis"], ["cache:6379"]],
      // An `@` in the password, unescaped.
      ["ftp://u:opaque@part@files.test/", ["opaque", "part"], ["files.test/"]],
      ["https://u:opaque-at@host\nnext line", ["opaque-at"], ["next line"]],
    ]);
    // An address in a path or query is not userinfo.
    const kept = "https://example.test/to/a@b.test?from=c@d.test";
    expect(redactSecretText(kept)).toBe(kept);
  });

  it("redacts a header's whole value, inline or on its own line", () => {
    check([
      [
        `curl -H "Cookie: session=opaque-a; csrf=opaque-b" -H 'Authorization: Digest username="u", response="opaque-c"' https://x.test`,
        ["opaque-a", "opaque-b", "opaque-c", "username"],
        ['-H "Cookie: [redacted]"', "-H 'Authorization: [redacted]'", " https://x.test"],
      ],
      ["Cookie: a=opaque-d; b=opaque-e\nHost: x.test", ["opaque-d", "opaque-e"], ["Host: x.test"]],
      ["Set-Cookie: sid=opaque-f; Path=/; HttpOnly", ["opaque-f"], ["Set-Cookie: "]],
      ["Proxy-Authorization: Negotiate opaque-g", ["opaque-g", "Negotiate"], []],
      ["Authorization: Bearer opaque-h", ["opaque-h"], ["Authorization: "]],
      ["X-Api-Key: opaque-i extra", ["opaque-i", "extra"], []],
      ['curl -H "x-auth-token: opaque-j" x.test', ["opaque-j"], [" x.test"]],
      // In JSON text, escaped once and twice.
      [
        '{"args":["-H","Cookie: a=opaque-k; b=opaque-l"]}',
        ["opaque-k", "opaque-l"],
        ['"Cookie: [redacted]"]}'],
      ],
      [
        '{\\"h\\":\\"Cookie: a=opaque-m; b=opaque-n\\",\\"x\\":1}',
        ["opaque-m", "opaque-n"],
        ['\\",\\"x\\":1}'],
      ],
      [
        "GET / HTTP/1.1\\r\\nCookie: a=opaque-o; b=opaque-p\\r\\nHost: h",
        ["opaque-p"],
        ["Host: h"],
      ],
      // YAML.
      ["db:\n  password: opaque q r\n  user: app", ["opaque", " q r"], ["user: app"]],
    ]);
  });

  it("redacts credential flags and a user's password", () => {
    check([
      ["mysqladmin --password opaque1 status", ["opaque1"], [" status"]],
      ["tool --api-key=opaque2 --verbose", ["opaque2"], ["--verbose"]],
      ["gh auth login --with-token --token 'opaque 3'", ["opaque", "3'"], []],
      ["curl -u alice:opaque4 https://x.test", ["opaque4"], ["https://x.test"]],
      ["curl --user 'alice:opaque 5' x", ["opaque", "5'"], [" x"]],
      ["curl --proxy-user bob:opaque6 x", ["opaque6"], []],
    ]);
    for (const text of ["git push -u origin main", "tool --no-password --max-tokens 100"])
      expect(redactSecretText(text)).toBe(text);
  });

  it("redacts private keys and tokens with a known prefix", () => {
    const pem =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\nok";
    check([
      [pem, ["b3BlbnNzaC1rZXktdjEAAAAA"], ["BEGIN OPENSSH PRIVATE KEY", "\nok"]],
      // Cut before its end line.
      ["-----BEGIN RSA PRIVATE KEY-----\nMIIEopaqueCut", ["MIIEopaqueCut"], []],
      [
        "ghp_abcdefghijklmnopqrstuvwxyz0123 github_pat_11ABCDEFG0abcdefghij_klmnop glpat-abcdefghijklmnopqrst",
        ["ghp_abc", "github_pat_11", "glpat-abc"],
        [],
      ],
      [
        "xoxb-1234567890-abcdefghij AIzaSyA1234567890abcdefghijklmnopqrstuv sk_live_abcdefghijklmnop1234 AKIAABCDEFGHIJKLMNOP",
        ["xoxb-123", "AIzaSy", "sk_live_abc", "AKIAABC"],
        [],
      ],
    ]);
  });

  it("leaves text without credentials as it is", () => {
    for (const text of [
      "Done: wrote notes.md at 10:00:00 (12 input tokens).",
      "max_tokens: 1200\nmodel: gpt-6.1",
      "See https://example.test/docs#auth and ssh git@github.com:o/r.git",
      '{"input_tokens":12,"status":"ok"}',
    ])
      expect(redactSecretText(text)).toBe(text);
  });

  it("never rewrites a value it already redacted", () => {
    const once = redactSecretText("Cookie: a=1; b=2\npassword=x\nhttps://u:p@h");
    expect(redactSecretText(once)).toBe(once);
    expect(once).toBe(`Cookie: ${REDACTED}\npassword=${REDACTED}\nhttps://${REDACTED}@h`);
  });
});

describe("isSecretKey", () => {
  it("names Docker's auth, passphrases and signatures, not ordinary names", () => {
    for (const key of ["auth", "pass", "passphrase", "X-Amz-Signature", "x-api-key"])
      expect(isSecretKey(key), key).toBe(true);
    for (const key of ["author", "authMode", "passage", "compass", "path"])
      expect(isSecretKey(key), key).toBe(false);
  });
});
