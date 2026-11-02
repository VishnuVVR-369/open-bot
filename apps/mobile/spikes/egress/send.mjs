// Sends the spike's high-priority FCM data message to one phone.
//
//   railway run --service worker -- node apps/mobile/spikes/egress/send.mjs <fcm-token> <case>
//
// FCM_SERVICE_ACCOUNT_JSON comes from the environment (the worker's, through `railway run`).
import { createSign } from "node:crypto";

const [token, label = "manual"] = process.argv.slice(2);
const account = JSON.parse(process.env.FCM_SERVICE_ACCOUNT_JSON ?? "null");
if (!token || !account) {
  console.error("usage: FCM_SERVICE_ACCOUNT_JSON=... node send.mjs <fcm-token> <case>");
  process.exit(1);
}

const base64url = (value) => Buffer.from(value).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
  JSON.stringify({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }),
)}`;
const signature = createSign("RSA-SHA256").update(unsigned).sign(account.private_key, "base64url");
const auth = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: `${unsigned}.${signature}`,
  }),
}).then((response) => response.json());
if (!auth.access_token) throw new Error(`no access token: ${auth.error ?? "unknown error"}`);

const sentAtMs = Date.now();
const response = await fetch(
  `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
  {
    method: "POST",
    headers: { authorization: `Bearer ${auth.access_token}`, "content-type": "application/json" },
    body: JSON.stringify({
      message: {
        token,
        data: { type: "egress-spike", case: label, sentAtMs: String(sentAtMs) },
        android: { priority: "HIGH", ttl: "120s" },
      },
    }),
  },
);
const result = await response.json();
console.log(
  JSON.stringify({
    case: label,
    sentAtMs,
    status: response.status,
    name: result.name,
    error: result.error?.message,
  }),
);
