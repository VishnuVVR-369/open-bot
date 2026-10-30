import { runAs, type SystemUser } from "./users";

/**
 * Whether Chromium's sandbox can run for `user` here. The sandbox puts each renderer in new user,
 * PID and network namespaces, so this tries to make the same ones. Some container hosts (Railway)
 * refuse new user namespaces and give no way to allow them, and Chromium then crashes on start.
 */
export function browserSandboxAvailable(user: SystemUser): Promise<boolean> {
  return runAs(user, "unshare", ["--user", "--pid", "--net", "--fork", "true"]).then(
    () => true,
    () => false,
  );
}
