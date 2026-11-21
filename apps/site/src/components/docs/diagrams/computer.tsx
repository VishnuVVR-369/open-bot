import { Box, Edge, Group, Svg } from "../svg";

/** The computer container: three Linux users, the processes each one runs, and the volume. */
export function ComputerDiagram() {
  const columns = [
    { x: 12, label: "runs as root" },
    { x: 256, label: "user desktop, per screen" },
    { x: 500, label: "user bot" },
  ];
  return (
    <Svg
      height={404}
      label="Inside the computer: botd as root, screens as the desktop user, Codex as the bot user"
    >
      {(m) => (
        <>
          <Group
            x={0}
            y={0}
            w={744}
            h={404}
            label="The computer container"
            note="images/computer"
            tone="wash"
          />
          {columns.map((column) => (
            <Group key={column.x} x={column.x} y={36} w={232} h={276} label={column.label} />
          ))}
          <Edge
            points={[
              [200, 84],
              [200, 70],
              [616, 70],
              [616, 84],
            ]}
            marker={m.arrow}
            label="starts codex app-server, bridges /codex to it"
            at={[408, 70]}
          />
          <Edge
            points={[
              [228, 120],
              [272, 120],
            ]}
            marker={m.arrow}
          />
          <Edge
            points={[
              [272, 198],
              [228, 198],
            ]}
            marker={m.arrow}
          />
          <Edge
            points={[
              [228, 148],
              [250, 148],
              [250, 262],
              [272, 262],
            ]}
            marker={m.arrow}
            bridge
          />

          <Box
            x={28}
            y={84}
            w={200}
            h={72}
            title="botd"
            sub={["API on port 7000, supervisor,", "screens, leases, cookie sync"]}
            tone="ink"
          />
          <Box
            x={28}
            y={172}
            w={200}
            h={52}
            title="SOCKS5 proxy"
            sub="127.0.0.1:1080, egress router"
          />
          <Box
            x={28}
            y={236}
            w={200}
            h={52}
            title="Cookie jar"
            sub="/home/.botd/cookies.json"
            mono
          />

          <Box
            x={272}
            y={84}
            w={200}
            h={72}
            title="Display and desktop"
            sub={["Xvfb on :10 + slot,", "an XFCE session"]}
          />
          <Box x={272} y={172} w={200} h={52} title="Chromium" sub="own profile, DevTools pipe" />
          <Box
            x={272}
            y={236}
            w={200}
            h={52}
            title="Two x11vnc servers"
            sub="watch port and control port"
          />

          <Box
            x={516}
            y={84}
            w={200}
            h={72}
            title="Codex app-server"
            sub={["ws://127.0.0.1:4500,", "every teammate's threads"]}
          />
          <Box
            x={516}
            y={172}
            w={200}
            h={52}
            title="Shell and file tools"
            sub="no access to any display"
          />
          <Box x={516} y={236} w={200} h={52} title="Workspaces" sub="/home/bot/bots/<slug>" mono />

          <Box
            x={12}
            y={330}
            w={720}
            h={58}
            title="/home is a persistent volume"
            sub="workspaces, shared folders, browser profiles, the Codex login and the cookie jar survive restarts"
            tone="sheet"
          />
        </>
      )}
    </Svg>
  );
}
