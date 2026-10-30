import { spawn } from "node:child_process";
import { asUser, type SystemUser } from "./users";

/**
 * Whether Chromium's sandbox can run for `user` here. The sandbox puts each renderer in new user,
 * PID and network namespaces, so this tries to make the same ones. Some container hosts (Railway)
 * refuse new user namespaces and give no way to allow them, and Chromium then crashes on start.
 */
export function browserSandboxAvailable(user: SystemUser): Promise<boolean> {
  const [command, args] = asUser(user, "unshare", ["--user", "--pid", "--net", "--fork", "true"]);
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}
