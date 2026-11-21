import { Box, Edge, Group, Label, Svg } from "../svg";

/** The processes and how they connect. */
export function SystemDiagram() {
  return (
    <Svg
      height={470}
      label="System overview: your devices, the app services and the shared computer"
    >
      {(m) => (
        <>
          <Group x={0} y={0} w={160} h={322} label="Your devices" />
          <Group x={200} y={0} w={300} h={428} label="App services" />
          <Group x={540} y={0} w={204} h={322} label="The computer" note="Docker" />

          {/* Browser to web app, and to the worker's VNC socket. */}
          <Edge
            points={[
              [146, 66],
              [216, 66],
            ]}
            marker={m.arrow}
            start={m.arrow}
            label="HTTPS"
            at={[181, 56]}
          />
          <Edge
            points={[
              [146, 88],
              [186, 88],
              [186, 172],
              [216, 172],
            ]}
            marker={m.arrow}
            start={m.arrow}
            label={["VNC", "socket"]}
            at={[192, 131]}
            anchor="start"
          />
          {/* Desktop app to the worker's egress socket, and out to websites. */}
          <Edge
            points={[
              [146, 232],
              [200, 232],
              [200, 192],
              [216, 192],
            ]}
            marker={m.arrow}
            start={m.arrow}
            label="egress"
            at={[200, 246]}
          />
          <Edge
            points={[
              [80, 264],
              [80, 364],
            ]}
            marker={m.arrow}
            label={["browser", "traffic"]}
            at={[88, 340]}
            anchor="start"
          />
          {/* Browser to the pages service, in a sandboxed frame. */}
          <Edge
            points={[
              [146, 100],
              [172, 100],
              [172, 382],
              [216, 382],
            ]}
            marker={m.arrow}
            bridge
            label={["signed", "link"]}
            at={[172, 340]}
          />

          {/* Inside the app services. */}
          <Edge
            points={[
              [300, 104],
              [300, 150],
            ]}
            marker={m.arrow}
            label="internal HTTP"
            at={[308, 127]}
            anchor="start"
          />
          <Edge
            points={[
              [300, 210],
              [300, 246],
            ]}
            marker={m.arrow}
            start={m.arrow}
            label="SQL, LISTEN/NOTIFY"
            at={[308, 228]}
            anchor="start"
          />
          <Edge
            points={[
              [300, 352],
              [300, 306],
            ]}
            marker={m.arrow}
            label="SQL, reads only"
            at={[308, 329]}
            anchor="start"
          />
          <Edge
            points={[
              [456, 70],
              [478, 70],
              [478, 276],
              [456, 276],
            ]}
            marker={m.arrow}
            start={m.arrow}
            label={["SQL,", "LISTEN"]}
            at={[478, 236]}
          />

          {/* The worker reaches the computer only through botd. */}
          <Edge
            points={[
              [456, 180],
              [556, 180],
            ]}
            marker={m.arrow}
            start={m.arrow}
            bridge
            label={["HTTP and", "websockets"]}
            at={[518, 204]}
          />
          <Edge
            points={[
              [642, 150],
              [642, 104],
            ]}
            marker={m.arrow}
          />
          <Edge
            points={[
              [642, 210],
              [642, 246],
            ]}
            marker={m.arrow}
          />
          <Edge
            points={[
              [642, 306],
              [642, 364],
            ]}
            marker={m.arrow}
            label={["model traffic,", "direct"]}
            at={[650, 340]}
            anchor="start"
          />

          <Box
            x={14}
            y={44}
            w={132}
            h={64}
            title="Browser"
            sub={["app UI, pages and", "the live screen view"]}
          />
          <Box
            x={14}
            y={200}
            w={132}
            h={64}
            title="Desktop app"
            sub={["Electron shell and", "egress agent"]}
          />

          <Box x={216} y={44} w={240} h={60} title="Web app" sub="Next.js, port 3000" />
          <Box
            x={216}
            y={150}
            w={240}
            h={60}
            title="Worker"
            sub="Node service, port 4001"
            tone="ink"
          />
          <Box x={216} y={246} w={240} h={60} title="Postgres" sub="data, run queue, event log" />
          <Box x={216} y={352} w={240} h={60} title="Pages" sub="its own origin, port 3400" />

          <Box
            x={556}
            y={44}
            w={172}
            h={60}
            title="Screens"
            sub={["Xvfb, XFCE, Chromium,", "x11vnc: one per teammate"]}
          />
          <Box
            x={556}
            y={150}
            w={172}
            h={60}
            title="botd"
            sub="control daemon, port 7000"
            tone="ink"
          />
          <Box x={556} y={246} w={172} h={60} title="Codex app-server" sub="the agent runtime" />

          <Box x={0} y={364} w={160} h={56} title="Websites" sub="see your home IP" tone="wash" />
          <Box
            x={540}
            y={364}
            w={204}
            h={56}
            title="OpenAI"
            sub="ChatGPT plan or API key"
            tone="wash"
          />

          <Label
            x={350}
            y={456}
            lines="Telegram, Postmark and Web Push talk to the worker directly."
          />
        </>
      )}
    </Svg>
  );
}
