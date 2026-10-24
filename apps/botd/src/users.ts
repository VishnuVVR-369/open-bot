import { readFileSync } from "node:fs";

export interface SystemUser {
  name: string;
  uid: number;
  gid: number;
  home: string;
}

export function lookupUser(name: string): SystemUser {
  const line = readFileSync("/etc/passwd", "utf8")
    .split("\n")
    .find((entry) => entry.startsWith(`${name}:`));
  if (!line) throw new Error(`User ${name} does not exist`);
  const [, , uid, gid, , home] = line.split(":");
  return { name, uid: Number(uid), gid: Number(gid), home: home ?? `/home/${name}` };
}

/**
 * Command and arguments that run `command` as `user`, with the user's supplementary groups.
 * Node can set the uid and gid of a child, but not its supplementary groups, so `setpriv` does it.
 */
export function asUser(
  user: SystemUser,
  command: string,
  args: string[],
  env: Record<string, string> = {},
): [string, string[]] {
  const variables = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: user.home,
    USER: user.name,
    LOGNAME: user.name,
    LANG: "en_US.UTF-8",
    ...env,
  };
  return [
    "setpriv",
    [
      `--reuid=${user.uid}`,
      `--regid=${user.gid}`,
      "--init-groups",
      "--reset-env",
      "--",
      "env",
      ...Object.entries(variables).map(([key, value]) => `${key}=${value}`),
      command,
      ...args,
    ],
  ];
}
