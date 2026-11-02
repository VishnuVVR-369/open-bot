import { ANDROID_PACKAGE, androidCertFingerprints } from "@/lib/server/auth-config";

export const dynamic = "force-dynamic";

/**
 * Associates this site with the Android app, so the app can use the site's passkeys and open its
 * links. Public, like every `.well-known` file.
 */
export function GET() {
  const fingerprints = androidCertFingerprints();
  const statements = fingerprints.length
    ? [
        {
          relation: [
            "delegate_permission/common.handle_all_urls",
            "delegate_permission/common.get_login_creds",
          ],
          target: {
            namespace: "android_app",
            package_name: ANDROID_PACKAGE,
            sha256_cert_fingerprints: fingerprints,
          },
        },
      ]
    : [];
  return Response.json(statements, {
    headers: { "cache-control": "public, max-age=3600" },
  });
}
