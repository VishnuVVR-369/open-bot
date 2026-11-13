import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { expo } from "@better-auth/expo";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it } from "vitest";
import { BASE_URL, MOBILE_ORIGIN, passkeyConfig, TRUSTED_ORIGINS } from "./auth-config";

/**
 * The passkey ceremonies as the phone runs them: the app's requests, and a credential made the
 * way Android's Credential Manager makes one, with the `android:apk-key-hash:` origin of the key
 * the app is signed with.
 */

const releaseCert = createHash("sha256").update("the release signing certificate").digest();
const otherCert = createHash("sha256").update("someone else's signing certificate").digest();
const fingerprint = (digest: Buffer) =>
  digest.toString("hex").toUpperCase().match(/../g)!.join(":");
const appOrigin = (digest: Buffer) => `android:apk-key-hash:${digest.toString("base64url")}`;

/** Just enough CBOR for an attestation object and a COSE key. */
function cbor(value: unknown): Buffer {
  const head = (major: number, length: number) =>
    length < 24
      ? Buffer.from([(major << 5) | length])
      : length < 256
        ? Buffer.from([(major << 5) | 24, length])
        : Buffer.from([(major << 5) | 25, length >> 8, length & 0xff]);
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (value instanceof Map)
    return Buffer.concat([
      head(5, value.size),
      ...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)]),
    ]);
  throw new Error(`can't encode ${typeof value}`);
}

const u32 = (value: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};

/** A phone's passkey provider, holding one credential. */
class Authenticator {
  private readonly key: KeyObject;
  private readonly publicKey: { x: string; y: string };
  readonly credentialId = randomBytes(16);
  private counter = 0;

  constructor(public origin: string) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.key = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.publicKey = { x: jwk.x!, y: jwk.y! };
  }

  private clientData(type: string, challenge: string) {
    return Buffer.from(
      JSON.stringify({
        type,
        challenge,
        origin: this.origin,
        androidPackageName: "dev.openbot.mobile",
      }),
    );
  }

  /** Flags: user present, user verified, and (when registering) attested credential data. */
  private authData(rpId: string, attested: Buffer | null) {
    const flags = 0x01 | 0x04 | (attested ? 0x40 : 0);
    return Buffer.concat([
      createHash("sha256").update(rpId).digest(),
      Buffer.from([flags]),
      u32(this.counter++),
      ...(attested ? [attested] : []),
    ]);
  }

  create(options: { challenge: string; rp: { id: string } }) {
    const coseKey = cbor(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(this.publicKey.x, "base64url")],
        [-3, Buffer.from(this.publicKey.y, "base64url")],
      ]),
    );
    const attested = Buffer.concat([
      Buffer.alloc(16),
      Buffer.from([this.credentialId.length >> 8, this.credentialId.length & 0xff]),
      this.credentialId,
      coseKey,
    ]);
    const attestationObject = cbor(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", this.authData(options.rp.id, attested)],
      ]),
    );
    const id = this.credentialId.toString("base64url");
    return {
      id,
      rawId: id,
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: this.clientData("webauthn.create", options.challenge).toString("base64url"),
        attestationObject: attestationObject.toString("base64url"),
        transports: ["internal", "hybrid"],
      },
    };
  }

  get(options: { challenge: string; rpId: string }) {
    const clientDataJSON = this.clientData("webauthn.get", options.challenge);
    const authenticatorData = this.authData(options.rpId, null);
    const signature = sign(
      "sha256",
      Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]),
      this.key,
    );
    const id = this.credentialId.toString("base64url");
    return {
      id,
      rawId: id,
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        authenticatorData: authenticatorData.toString("base64url"),
        signature: signature.toString("base64url"),
      },
    };
  }
}

function server() {
  return betterAuth({
    baseURL: BASE_URL,
    secret: "a test-only secret that is long enough for better auth",
    database: memoryAdapter({ user: [], session: [], account: [], verification: [], passkey: [] }),
    emailAndPassword: { enabled: true },
    trustedOrigins: TRUSTED_ORIGINS,
    plugins: [passkey(passkeyConfig([fingerprint(releaseCert)])), expo()],
  });
}

/** The few fields the tests read from the endpoints' answers (null when there's no body). */
type Reply = {
  code?: string;
  challenge: string;
  rp: { id: string };
  rpId: string;
  user: { email: string };
};

/** The phone's side of the conversation: the Expo client's headers and cookie jar. */
function phone(auth: ReturnType<typeof server>) {
  const jar = new Map<string, string>();
  return async (method: "GET" | "POST", path: string, body?: unknown) => {
    const response = await auth.handler(
      new Request(`${BASE_URL}/api/auth${path}`, {
        method,
        headers: {
          "expo-origin": MOBILE_ORIGIN,
          cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ""] = cookie.split(";");
      const at = pair.indexOf("=");
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return { status: response.status, body: (await response.json().catch(() => null)) as Reply };
  };
}

async function signedInPhone(auth: ReturnType<typeof server>) {
  const request = phone(auth);
  const signUp = await request("POST", "/sign-up/email", {
    email: "owner@example.com",
    password: "a long enough password",
    name: "Owner",
  });
  expect(signUp.status).toBe(200);
  return request;
}

describe("passkeys from the Android app", () => {
  it("registers a passkey made by the release-signed app, then signs in with it", async () => {
    const auth = server();
    const authenticator = new Authenticator(appOrigin(releaseCert));

    const owner = await signedInPhone(auth);
    const creation = await owner("GET", "/passkey/generate-register-options");
    expect(creation.status).toBe(200);
    const registered = await owner("POST", "/passkey/verify-registration", {
      response: authenticator.create(creation.body),
      name: "Phone",
    });
    expect(registered.status).toBe(200);

    // A phone that's signed out: the challenge cookie is all it has.
    const signedOut = phone(auth);
    const request = await signedOut("GET", "/passkey/generate-authenticate-options");
    expect(request.status).toBe(200);
    const signedIn = await signedOut("POST", "/passkey/verify-authentication", {
      response: authenticator.get(request.body),
    });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.user.email).toBe("owner@example.com");
    expect((await signedOut("GET", "/get-session")).body?.user.email).toBe("owner@example.com");
  });

  it("refuses passkeys from an app signed with another key", async () => {
    const auth = server();
    const owner = await signedInPhone(auth);

    const impostor = new Authenticator(appOrigin(otherCert));
    const creation = await owner("GET", "/passkey/generate-register-options");
    const refused = await owner("POST", "/passkey/verify-registration", {
      response: impostor.create(creation.body),
      name: "Phone",
    });
    // The plugin answers any failed verification with a 500 and this code.
    expect(refused.body.code).toBe("FAILED_TO_VERIFY_REGISTRATION");
    expect((await owner("GET", "/passkey/list-user-passkeys")).body).toEqual([]);

    // A real passkey, used through an app that isn't open-bot's.
    const authenticator = new Authenticator(appOrigin(releaseCert));
    const again = await owner("GET", "/passkey/generate-register-options");
    await owner("POST", "/passkey/verify-registration", {
      response: authenticator.create(again.body),
      name: "Phone",
    });
    authenticator.origin = appOrigin(otherCert);
    const signedOut = phone(auth);
    const request = await signedOut("GET", "/passkey/generate-authenticate-options");
    const signIn = await signedOut("POST", "/passkey/verify-authentication", {
      response: authenticator.get(request.body),
    });
    expect(signIn.body.code).toBe("AUTHENTICATION_FAILED");
    expect((await signedOut("GET", "/get-session")).body).toBeNull();
  });
});
