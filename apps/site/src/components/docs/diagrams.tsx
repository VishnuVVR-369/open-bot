import { Box, Edge, Group, Label, State, Svg } from "./svg";

/** The five processes and how they connect. */
export function SystemDiagram() {
  return (
    <Svg
      height={424}
      label="System overview: your devices, the app services and the shared computer"
    >
      {(m) => (
        <>
          <Group x={0} y={0} w={160} h={322} label="Your devices" />
          <Group x={200} y={0} w={300} h={322} label="App services" />
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
              [146, 90],
              [174, 90],
              [174, 172],
              [216, 172],
            ]}
            marker={m.arrow}
            start={m.arrow}
            label={["VNC", "socket"]}
            at={[174, 132]}
          />
          {/* Desktop app to the worker's egress socket, and out to websites. */}
          <Edge
            points={[
              [146, 232],
              [190, 232],
              [190, 192],
              [216, 192],
            ]}
            marker={m.arrow}
            start={m.arrow}
            label="egress"
            at={[190, 246]}
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
            sub={["app UI, and the", "live screen view"]}
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
            x={250}
            y={392}
            anchor="start"
            lines={["Telegram, Postmark and Web Push", "talk to the worker directly."]}
          />
        </>
      )}
    </Svg>
  );
}

/** The main records and how they relate. */
export function ConceptsDiagram() {
  return (
    <Svg height={318} label="Core concepts: teammates, chats, runs, threads, screens and events">
      {(m) => (
        <>
          <Edge
            points={[
              [170, 52],
              [287, 52],
            ]}
            marker={m.arrow}
            label="is in many"
            at={[228, 40]}
          />
          <Edge
            points={[
              [457, 52],
              [574, 52],
            ]}
            marker={m.arrow}
            label="has many"
            at={[515, 40]}
          />
          <Edge
            points={[
              [85, 84],
              [85, 140],
            ]}
            marker={m.arrow}
            label="has one"
            at={[93, 112]}
            anchor="start"
          />
          <Edge
            points={[
              [372, 84],
              [372, 140],
            ]}
            marker={m.arrow}
            label={["one per teammate", "in the chat"]}
            at={[380, 112]}
            anchor="start"
          />
          <Edge
            points={[
              [574, 76],
              [532, 76],
              [532, 172],
              [457, 172],
            ]}
            marker={m.arrow}
            label={["runs one", "turn on"]}
            at={[532, 132]}
          />
          <Edge
            points={[
              [659, 84],
              [659, 140],
            ]}
            marker={m.arrow}
            label="appends"
            at={[667, 112]}
            anchor="start"
          />
          <Edge
            points={[
              [85, 204],
              [85, 256],
            ]}
            marker={m.arrow}
            label="works in"
            at={[93, 230]}
            anchor="start"
          />
          <Edge
            points={[
              [372, 256],
              [372, 204],
            ]}
            marker={m.arrow}
            label="read into every run"
            at={[380, 230]}
            anchor="start"
          />
          <Edge
            points={[
              [659, 204],
              [659, 256],
            ]}
            marker={m.arrow}
            label="point to"
            at={[667, 230]}
            anchor="start"
          />

          <Box
            x={0}
            y={20}
            w={170}
            h={64}
            title="Teammate"
            sub={["bots: a job, instructions,", "autonomy and model"]}
            tone="ink"
          />
          <Box
            x={287}
            y={20}
            w={170}
            h={64}
            title="Chat"
            sub={["direct, group, or a", "Scheduled or Email chat"]}
          />
          <Box
            x={574}
            y={20}
            w={170}
            h={64}
            title="Run"
            sub={["one turn of one", "teammate in one chat"]}
            tone="ink"
          />
          <Box
            x={0}
            y={140}
            w={170}
            h={64}
            title="Screen"
            sub={["a display, a browser", "and a lease"]}
          />
          <Box
            x={287}
            y={140}
            w={170}
            h={64}
            title="Thread"
            sub={["a Codex conversation", "with its history"]}
          />
          <Box
            x={574}
            y={140}
            w={170}
            h={64}
            title="Run events"
            sub={["the ordered log of", "what the run did"]}
          />
          <Box x={0} y={256} w={170} h={56} title="Workspace" sub="/home/bot/bots/<slug>" mono />
          <Box x={287} y={256} w={170} h={56} title="Memory" sub="shared and per teammate" />
          <Box x={574} y={256} w={170} h={56} title="Artifacts" sub="screenshots, in Postgres" />
        </>
      )}
    </Svg>
  );
}

/** The four ways the browser reaches the Next.js server. */
export function WebAppDiagram() {
  const rows = [
    { title: "Pages", sub: "server components, first render" },
    { title: "Server actions", sub: "every write, in lib/actions.ts" },
    { title: "Read routes", sub: "GET /api/*, for client queries" },
    { title: "Event stream", sub: "GET /api/stream, server-sent events" },
  ];
  return (
    <Svg height={352} label="The web app: pages, server actions, read routes and the event stream">
      {(m) => (
        <>
          <Group x={196} y={0} w={330} h={300} label="Next.js server" note="apps/web" />
          <Edge
            points={[
              [140, 150],
              [196, 150],
            ]}
            marker={m.arrow}
            start={m.arrow}
            label={["HTTPS,", "cookie"]}
            at={[168, 126]}
          />
          <Edge
            points={[
              [526, 92],
              [590, 92],
            ]}
            marker={m.arrow}
            start={m.arrow}
            label={["Drizzle,", "LISTEN"]}
            at={[558, 68]}
          />
          <Edge
            points={[
              [526, 228],
              [590, 228],
            ]}
            marker={m.arrow}
            label={["internal", "HTTP"]}
            at={[558, 204]}
          />
          <Edge
            points={[
              [70, 182],
              [70, 330],
              [667, 330],
              [667, 260],
            ]}
            marker={m.arrow}
            start={m.arrow}
            label="VNC websocket, with a short-lived signed token"
            at={[370, 330]}
          />

          <Box
            x={0}
            y={118}
            w={140}
            h={64}
            title="Browser"
            sub={["React Query cache,", "one EventSource"]}
          />
          {rows.map((row, i) => (
            <Box
              key={row.title}
              x={212}
              y={40 + i * 64}
              w={298}
              h={52}
              title={row.title}
              sub={row.sub}
            />
          ))}
          <Box x={590} y={60} w={154} h={64} title="Postgres" sub="reads and writes" />
          <Box x={590} y={196} w={154} h={64} title="Worker" sub="anything that acts" tone="ink" />
        </>
      )}
    </Svg>
  );
}

/** The worker's main parts. */
export function WorkerDiagram() {
  return (
    <Svg
      height={420}
      label="Inside the worker: HTTP server, executor, sessions, tools and connections"
    >
      {(m) => (
        <>
          <Group x={150} y={0} w={440} h={378} label="Worker process" note="apps/worker" />
          <Edge
            points={[
              [120, 62],
              [166, 62],
            ]}
            marker={m.arrow}
          />
          <Edge
            points={[
              [120, 150],
              [166, 150],
            ]}
            marker={m.arrow}
            start={m.arrow}
          />
          <Edge
            points={[
              [264, 88],
              [264, 124],
            ]}
            marker={m.arrow}
            label="dispatch, cancel"
            at={[272, 106]}
            anchor="start"
          />
          <Edge
            points={[
              [476, 88],
              [476, 124],
            ]}
            marker={m.arrow}
            label="pump"
            at={[484, 106]}
            anchor="start"
          />
          <Edge
            points={[
              [264, 176],
              [264, 212],
            ]}
            marker={m.arrow}
            label="start a session"
            at={[272, 194]}
            anchor="start"
          />
          <Edge
            points={[
              [346, 238],
              [394, 238],
            ]}
            marker={m.arrow}
            label="tools"
            at={[370, 226]}
          />
          <Edge
            points={[
              [228, 264],
              [228, 300],
            ]}
            marker={m.arrow}
            start={m.arrow}
          />
          <Edge
            points={[
              [484, 264],
              [484, 282],
              [370, 282],
              [370, 300],
            ]}
            marker={m.arrow}
          />
          <Edge
            points={[
              [228, 352],
              [228, 400],
              [684, 400],
              [684, 352],
            ]}
            marker={m.arrow}
          />
          <Edge
            points={[
              [370, 352],
              [370, 400],
            ]}
          />
          <Edge
            points={[
              [512, 352],
              [512, 400],
            ]}
          />
          <Label x={234} y={388} anchor="start" lines="/codex" mono />
          <Label x={376} y={388} anchor="start" lines="/events, HTTP" mono />
          <Label x={518} y={388} anchor="start" lines="/egress" mono />

          <Box x={0} y={36} w={120} h={52} title="Web app" sub="internal HTTP" />
          <Box x={0} y={124} w={120} h={52} title="Postgres" sub="queue, events" />
          <Box x={166} y={36} w={196} h={52} title="HTTP server" sub="/internal/*, /vnc, /egress" />
          <Box
            x={378}
            y={36}
            w={196}
            h={52}
            title="Timers and signals"
            sub="LISTEN, scheduler, watches"
          />
          <Box
            x={166}
            y={124}
            w={408}
            h={52}
            title="RunExecutor"
            sub="claims queued runs, up to MAX_CONCURRENT_RUNS at once"
            tone="ink"
          />
          <Box x={166} y={212} w={180} h={52} title="RunSession" sub="one per executing run" />
          <Box
            x={394}
            y={212}
            w={180}
            h={52}
            title="ToolHandlers"
            sub="and the services behind them"
          />
          <Box x={166} y={300} w={124} h={52} title="CodexManager" sub="one socket" />
          <Box x={308} y={300} w={124} h={52} title="ComputerClient" sub="botd API" />
          <Box x={450} y={300} w={124} h={52} title="EgressRelay" sub="tunnel" />
          <Box x={624} y={300} w={120} h={52} title="botd" sub="port 7000" tone="ink" />
        </>
      )}
    </Svg>
  );
}

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

/** How a run picks its Codex thread. */
export function ThreadDecisionDiagram() {
  return (
    <Svg
      height={430}
      label="How a run chooses between starting, forking, resuming or reusing a Codex thread"
    >
      {(m) => (
        <>
          <Edge
            points={[
              [260, 38],
              [612, 38],
              [612, 84],
            ]}
            marker={m.arrow}
            label="no"
            at={[436, 38]}
          />
          <Edge
            points={[
              [130, 66],
              [130, 100],
            ]}
            marker={m.arrow}
            label="yes"
            at={[138, 83]}
            anchor="start"
          />
          <Edge
            points={[
              [260, 128],
              [480, 128],
            ]}
            marker={m.arrow}
            label="no"
            at={[370, 128]}
          />
          <Edge
            points={[
              [130, 156],
              [130, 190],
            ]}
            marker={m.arrow}
            label="yes"
            at={[138, 173]}
            anchor="start"
          />
          <Edge
            points={[
              [260, 218],
              [480, 218],
            ]}
            marker={m.arrow}
            label="no"
            at={[370, 218]}
          />
          <Edge
            points={[
              [130, 246],
              [130, 280],
            ]}
            marker={m.arrow}
            label="yes"
            at={[138, 263]}
            anchor="start"
          />
          <Edge
            points={[
              [260, 308],
              [480, 308],
            ]}
            marker={m.arrow}
            label="no"
            at={[370, 308]}
          />
          <Edge
            points={[
              [130, 336],
              [130, 370],
            ]}
            marker={m.arrow}
            label="yes"
            at={[138, 353]}
            anchor="start"
          />

          <Box
            x={0}
            y={10}
            w={260}
            h={56}
            title="A thread saved for this pair?"
            sub="bot_threads (chat, teammate)"
          />
          <Box
            x={0}
            y={100}
            w={260}
            h={56}
            title="Same tools and memory?"
            sub="TOOLS_VERSION, memory generation"
          />
          <Box
            x={0}
            y={190}
            w={260}
            h={56}
            title="Same provider and MCP set?"
            sub="auth mode, connections key"
          />
          <Box
            x={0}
            y={280}
            w={260}
            h={56}
            title="Loaded in app-server?"
            sub="since the last reconnect"
          />
          <Box x={0} y={370} w={260} h={56} title="Reuse it" sub="nothing to send" tone="wash" />

          <Box
            x={480}
            y={84}
            w={264}
            h={64}
            title="thread/start"
            sub={["a fresh thread, with instructions", "and every dynamic tool"]}
            tone="ink"
          />
          <Box
            x={480}
            y={190}
            w={264}
            h={56}
            title="thread/fork"
            sub="new provider or MCP set, same history"
          />
          <Box
            x={480}
            y={280}
            w={264}
            h={56}
            title="thread/resume"
            sub="load it from Codex's state on disk"
          />
        </>
      )}
    </Svg>
  );
}

/** The states a run moves through. */
export function RunStatusDiagram() {
  return (
    <Svg
      height={270}
      label="Run states: queued, starting, running, waiting, then completed, failed or interrupted"
    >
      {(m) => (
        <>
          <Edge
            points={[
              [104, 99],
              [164, 99],
            ]}
            marker={m.arrow}
            label="claimed"
            at={[134, 85]}
          />
          <Edge
            points={[
              [268, 99],
              [332, 99],
            ]}
            marker={m.arrow}
            label={["turn", "started"]}
            at={[300, 78]}
          />
          <Edge
            points={[
              [372, 118],
              [372, 180],
            ]}
            marker={m.arrow}
            label={["approval or", "takeover"]}
            at={[364, 149]}
            anchor="end"
          />
          <Edge
            points={[
              [412, 180],
              [412, 118],
            ]}
            marker={m.arrow}
            label="answered"
            at={[420, 149]}
            anchor="start"
          />
          <Edge
            points={[
              [452, 99],
              [500, 99],
              [500, 39],
              [568, 39],
            ]}
            marker={m.arrow}
            label="turn completed"
            at={[534, 25]}
          />
          <Edge
            points={[
              [500, 99],
              [568, 99],
            ]}
            marker={m.arrow}
            label="error"
            at={[534, 85]}
          />
          <Edge
            points={[
              [500, 99],
              [500, 159],
              [568, 159],
            ]}
            marker={m.arrow}
            label="stopped"
            at={[534, 145]}
          />
          <Edge
            points={[
              [52, 118],
              [52, 250],
              [656, 250],
              [656, 178],
            ]}
            marker={m.arrow}
            label="cancelled before it was claimed"
            at={[360, 250]}
          />

          <State x={0} y={80} w={104} label="queued" />
          <State x={164} y={80} w={104} label="starting" />
          <State x={332} y={80} w={120} label="running" tone="ink" />
          <State x={332} y={180} w={120} label="waiting" tone="manual" />
          <State x={572} y={20} w={168} label="completed" />
          <State x={572} y={80} w={168} label="failed" tone="live" />
          <State x={572} y={140} w={168} label="interrupted" />
        </>
      )}
    </Svg>
  );
}

/** The path of one browser connection from the computer to a website. */
export function EgressDiagram() {
  const boxes = [
    { title: "Chromium", sub: ["on a screen,", "in the computer"] },
    { title: "botd", sub: ["SOCKS5 server,", "egress router"] },
    { title: "Worker", sub: ["EgressRelay:", "pairs two sockets"] },
    { title: "Desktop app", sub: ["EgressAgent,", "on your Mac"] },
    { title: "Website", sub: ["sees your", "home IP"] },
  ];
  const labels = ["SOCKS5, :1080", "WS /egress", "WS /egress/agent", "plain TCP"];
  return (
    <Svg
      height={250}
      label="Browser egress: Chromium to botd to the worker to the desktop app to the website"
    >
      {(m) => (
        <>
          {labels.map((label, i) => (
            <Edge
              key={label}
              points={[
                [i * 160 + 104, 102],
                [i * 160 + 160, 102],
              ]}
              marker={m.arrow}
              start={i === 1 || i === 2 ? m.arrow : undefined}
            />
          ))}
          <Edge
            points={[
              [208, 134],
              [208, 214],
              [676, 214],
              [676, 134],
            ]}
            marker={m.arrow}
            dashed
            muted
            label="direct, when the mode is Off, or Prefer and your Mac is offline"
            at={[442, 214]}
          />
          {boxes.map((box, i) => (
            <Box
              key={box.title}
              x={i * 160}
              y={70}
              w={104}
              h={64}
              title={box.title}
              sub={box.sub}
              tone={i === 2 ? "ink" : i === 4 ? "wash" : "sheet"}
            />
          ))}
          {labels.map((label, i) => (
            <Label key={label} x={i * 160 + 132} y={156} lines={label} mono size={11} />
          ))}
          <Label x={104} y={38} lines="the computer" weight={600} color="#14161b" />
          <Label x={372} y={38} lines="app services" weight={600} color="#14161b" />
          <Label x={532} y={38} lines="your Mac" weight={600} color="#14161b" />
          <Label x={692} y={38} lines="the internet" weight={600} color="#14161b" />
        </>
      )}
    </Svg>
  );
}

/** The binary frame format of the egress tunnel. */
export function FrameDiagram() {
  return (
    <Svg height={132} label="An egress frame: one byte type, four byte stream id, then the payload">
      {() => (
        <>
          <Box x={0} y={10} w={140} h={64} title="type" sub="1 byte" tone="ink" mono />
          <Box x={140} y={10} w={210} h={64} title="stream id" sub="4 bytes, big endian" mono />
          <Box x={350} y={10} w={394} h={64} title="payload" sub="0 to 64 KiB" tone="wash" mono />
          <Label
            x={0}
            y={98}
            anchor="start"
            lines="1 Open {host, port} · 2 OpenOk · 3 OpenFail · 4 Data · 5 End (half close) · 6 Reset · 7 Window"
            mono
            size={11.25}
            color="#14161b"
          />
          <Label
            x={0}
            y={120}
            anchor="start"
            lines="Text messages on the same socket carry JSON control: config, peer-up, peer-down."
            mono
            size={11.25}
            color="#14161b"
          />
        </>
      )}
    </Svg>
  );
}

/** Who can hold a screen, and what moves the lease between them. */
export function LeaseDiagram() {
  return (
    <Svg height={312} label="The screen lease: free, held by a run, or held by you">
      {(m) => (
        <>
          <Edge
            points={[
              [318, 58],
              [96, 200],
            ]}
            marker={m.arrow}
            label={["a run's first", "desktop action"]}
            at={[188, 112]}
            anchor="end"
          />
          <Edge
            points={[
              [134, 200],
              [350, 58],
            ]}
            marker={m.arrow}
            label={["run ends, or", "2 min idle"]}
            at={[258, 140]}
            anchor="start"
          />
          <Edge
            points={[
              [426, 58],
              [648, 200],
            ]}
            marker={m.arrow}
            label="Take over"
            at={[556, 112]}
            anchor="start"
          />
          <Edge
            points={[
              [610, 200],
              [394, 58],
            ]}
            marker={m.arrow}
            label={["Hand back, 10 min", "idle, 90 s offline"]}
            at={[486, 140]}
            anchor="end"
          />
          <Edge
            points={[
              [190, 219],
              [554, 219],
            ]}
            marker={m.arrow}
            label="Take over: preempts the run at once"
            at={[372, 207]}
          />

          <State x={297} y={20} w={150} label="free" />
          <State x={40} y={200} w={150} label="held by a run" tone="ink" />
          <State x={554} y={200} w={150} label="held by you" tone="manual" />
          <Label
            x={115}
            y={272}
            lines={["another run of the teammate waits", "up to 30 s, then hears it's busy"]}
          />
          <Label
            x={629}
            y={272}
            lines={["that teammate's desktop tools", "fail, screenshots included"]}
          />
        </>
      )}
    </Svg>
  );
}

/** How a run decides between the plan and the API key. */
export function ModelAccessDiagram() {
  return (
    <Svg height={380} label="Choosing the ChatGPT plan or the API key for a run">
      {(m) => (
        <>
          <Edge
            points={[
              [260, 38],
              [480, 38],
            ]}
            marker={m.arrow}
            label="no"
            at={[370, 38]}
          />
          <Edge
            points={[
              [130, 66],
              [130, 120],
            ]}
            marker={m.arrow}
            label="yes"
            at={[138, 93]}
            anchor="start"
          />
          <Edge
            points={[
              [260, 148],
              [480, 148],
            ]}
            marker={m.arrow}
            label="no"
            at={[370, 148]}
          />
          <Edge
            points={[
              [130, 176],
              [130, 230],
            ]}
            marker={m.arrow}
            label="yes"
            at={[138, 203]}
            anchor="start"
          />
          <Edge
            points={[
              [260, 258],
              [480, 258],
            ]}
            marker={m.arrow}
            label="yes"
            at={[370, 258]}
          />
          <Edge
            points={[
              [130, 286],
              [130, 320],
            ]}
            marker={m.arrow}
            label="no"
            at={[138, 303]}
            anchor="start"
          />

          <Box
            x={0}
            y={10}
            w={260}
            h={56}
            title="Is the plan limited now?"
            sub="settings.plan_limited_until > now"
          />
          <Box
            x={0}
            y={120}
            w={260}
            h={56}
            title="Is an API key saved?"
            sub="credentials, AES-256-GCM"
          />
          <Box
            x={0}
            y={230}
            w={260}
            h={56}
            title="Has the month hit the cap?"
            sub="sum of usage_entries.cost_micros"
          />

          <Box
            x={480}
            y={10}
            w={264}
            h={56}
            title="Use the ChatGPT plan"
            sub="Codex's built-in openai provider"
            tone="ink"
          />
          <Box
            x={480}
            y={120}
            w={264}
            h={56}
            title="Blocked: no key"
            sub="the run fails with a clear message"
            tone="live"
          />
          <Box
            x={480}
            y={230}
            w={264}
            h={56}
            title="Blocked: cap reached"
            sub="the run fails, and you're notified"
            tone="live"
          />
          <Box
            x={0}
            y={320}
            w={260}
            h={56}
            title="Use the API key"
            sub="as this thread's own provider"
            tone="ink"
          />
        </>
      )}
    </Svg>
  );
}

/** One notification, delivered to every channel. */
export function NotificationDiagram() {
  return (
    <Svg height={232} label="A notification fans out to open tabs, push and Telegram">
      {(m) => (
        <>
          <Edge
            points={[
              [180, 116],
              [214, 116],
              [214, 50],
              [262, 50],
            ]}
            marker={m.arrow}
          />
          <Edge
            points={[
              [214, 116],
              [214, 172],
              [262, 172],
            ]}
            marker={m.arrow}
          />
          <Edge
            points={[
              [482, 50],
              [556, 50],
            ]}
            marker={m.arrow}
          />
          <Edge
            points={[
              [482, 172],
              [520, 172],
              [520, 116],
              [556, 116],
            ]}
            marker={m.arrow}
          />
          <Edge
            points={[
              [520, 172],
              [556, 172],
            ]}
            marker={m.arrow}
          />
          <Edge
            points={[
              [520, 172],
              [520, 220],
              [556, 220],
            ]}
            marker={m.arrow}
          />

          <Box
            x={0}
            y={84}
            w={180}
            h={64}
            title="createNotification()"
            sub={["a run finished or failed,", "an approval, a request"]}
            tone="ink"
          />
          <Box
            x={262}
            y={20}
            w={220}
            h={60}
            title="notifications row"
            sub="then NOTIFY openbot_app"
          />
          <Box
            x={262}
            y={142}
            w={220}
            h={60}
            title="worker event"
            sub="events.emit('notification')"
            mono
          />
          <Box
            x={556}
            y={20}
            w={188}
            h={60}
            title="Open tabs"
            sub="inbox, toast, OS notification"
          />
          <Box x={556} y={92} w={188} h={48} title="Web Push" sub="every subscribed device" />
          <Box x={556} y={148} w={188} h={48} title="Telegram" sub="the linked chat" />
          <Box x={556} y={200} w={188} h={32} title="Electron, natively" />
        </>
      )}
    </Svg>
  );
}

/** A swarm: one run fans out to helpers, and their results fan back in. */
export function SwarmDiagram() {
  const helpers = [20, 100, 180];
  return (
    <Svg
      height={270}
      label="A swarm splits a job across helpers on their own screens, then merges the results"
    >
      {(m) => (
        <>
          {helpers.map((y) => (
            <g key={y}>
              <Edge
                points={[
                  [160, 132],
                  [212, 132],
                  [212, y + 28],
                  [272, y + 28],
                ]}
                marker={m.arrow}
              />
              <Edge
                points={[
                  [472, y + 28],
                  [532, y + 28],
                  [532, 132],
                  [584, 132],
                ]}
                marker={m.arrow}
              />
            </g>
          ))}
          <Box
            x={0}
            y={96}
            w={160}
            h={72}
            title="Lead run"
            sub={["calls start_swarm", "with 2 to 6 parts"]}
            tone="ink"
          />
          {helpers.map((y, i) => (
            <Box
              key={y}
              x={272}
              y={y}
              w={200}
              h={56}
              title={i === 2 ? "Helper N" : `Helper ${i + 1}`}
              sub={`trigger swarm, screen ${i === 2 ? "N" : i + 1}`}
            />
          ))}
          <Box
            x={584}
            y={96}
            w={160}
            h={72}
            title="swarm_results run"
            sub={["the lead merges", "every result"]}
            tone="ink"
          />
          <Label
            x={372}
            y={258}
            lines="each helper is the same teammate in a hidden chat, with runs.screen_id = its task id"
          />
        </>
      )}
    </Svg>
  );
}

/** How memory is chosen for a run. */
export function MemoryRecallDiagram() {
  return (
    <Svg
      height={208}
      label="Memory recall: lexical and semantic search, fused, then bounded into a packet"
    >
      {(m) => (
        <>
          <Edge
            points={[
              [124, 104],
              [150, 104],
              [150, 46],
              [176, 46],
            ]}
            marker={m.arrow}
          />
          <Edge
            points={[
              [150, 104],
              [150, 162],
              [176, 162],
            ]}
            marker={m.arrow}
          />
          <Edge
            points={[
              [352, 46],
              [380, 46],
              [380, 104],
              [404, 104],
            ]}
            marker={m.arrow}
          />
          <Edge
            points={[
              [352, 162],
              [380, 162],
              [380, 104],
            ]}
          />
          <Edge
            points={[
              [564, 104],
              [592, 104],
            ]}
            marker={m.arrow}
          />

          <Box x={0} y={72} w={124} h={64} title="The request" sub="run.prompt" mono />
          <Box
            x={176}
            y={14}
            w={176}
            h={64}
            title="Full-text search"
            sub={["Postgres, English,", "top 30, pinned first"]}
          />
          <Box
            x={176}
            y={130}
            w={176}
            h={64}
            title="Vector search"
            sub={["pgvector, optional,", "top 30 under a cutoff"]}
            tone="wash"
          />
          <Box
            x={404}
            y={72}
            w={160}
            h={64}
            title="Rank fusion"
            sub={["pinned first,", "then RRF, top 12"]}
            tone="ink"
          />
          <Box
            x={592}
            y={72}
            w={152}
            h={64}
            title="Packet"
            sub={["at most 6,000 chars,", "with ids and revisions"]}
          />
        </>
      )}
    </Svg>
  );
}

/** Where the trust boundaries are, and what crosses each. */
export function TrustDiagram() {
  return (
    <Svg height={340} label="Trust boundaries and the credential on each connection">
      {(m) => (
        <>
          <Group x={0} y={0} w={170} h={296} label="Outside" />
          <Group x={210} y={0} w={300} h={296} label="App services" />
          <Group x={550} y={0} w={194} h={296} label="Computer" />

          <Edge
            points={[
              [150, 66],
              [226, 66],
            ]}
            marker={m.arrow}
            label={["session", "cookie"]}
            at={[188, 44]}
          />
          <Edge
            points={[
              [150, 90],
              [184, 90],
              [184, 196],
              [226, 196],
            ]}
            marker={m.arrow}
            label={["VNC token,", "60 s"]}
            at={[184, 142]}
          />
          <Edge
            points={[
              [150, 236],
              [196, 236],
              [196, 220],
              [226, 220],
            ]}
            marker={m.arrow}
            label={["egress token,", "120 s"]}
            at={[150, 258]}
            anchor="start"
          />
          <Edge
            points={[
              [326, 92],
              [326, 180],
            ]}
            marker={m.arrow}
            label="x-worker-secret"
            at={[318, 136]}
            anchor="end"
          />
          <Edge
            points={[
              [494, 208],
              [566, 208],
            ]}
            marker={m.arrow}
            label={["Bearer", "BOTD_TOKEN"]}
            at={[530, 154]}
          />

          <Box x={14} y={44} w={136} h={64} title="Your browser" sub="owner account only" />
          <Box x={14} y={204} w={136} h={64} title="Desktop app" sub="signed in as you" />
          <Box x={226} y={44} w={268} h={48} title="Web app" sub="Better Auth, one owner email" />
          <Box
            x={226}
            y={180}
            w={268}
            h={56}
            title="Worker"
            sub="holds ENCRYPTION_KEY, decrypts secrets"
            tone="ink"
          />
          <Box x={566} y={180} w={162} h={56} title="botd" sub="root, the only way in" tone="ink" />
          <Box x={566} y={258} w={162} h={56} title="Codex, shell" sub="user bot, no display" />
          <Box x={566} y={44} w={162} h={56} title="Screens" sub="user desktop" />
          <Label
            x={0}
            y={324}
            anchor="start"
            lines="Postgres holds API keys, vault items, connection headers and the Telegram token, encrypted with AES-256-GCM."
          />
        </>
      )}
    </Svg>
  );
}

/** A cloud deployment: four services in one private network, plus the Mac. */
export function DeploymentDiagram() {
  return (
    <Svg
      height={300}
      label="Cloud deployment: web and worker public, Postgres and the computer private"
    >
      {(m) => (
        <>
          <Group x={180} y={0} w={564} h={250} label="One project, one private network" />
          <Edge
            points={[
              [150, 66],
              [212, 66],
            ]}
            marker={m.arrow}
            label="HTTPS"
            at={[181, 54]}
          />
          <Edge
            points={[
              [150, 92],
              [176, 92],
              [176, 182],
              [212, 182],
            ]}
            marker={m.arrow}
            label={["WSS", "/vnc"]}
            at={[176, 137]}
          />
          <Edge
            points={[
              [150, 244],
              [196, 244],
              [196, 206],
              [212, 206],
            ]}
            marker={m.arrow}
            label="WSS /egress/agent"
            at={[150, 266]}
            anchor="start"
          />
          <Edge
            points={[
              [300, 104],
              [300, 156],
            ]}
            marker={m.arrow}
            label="private HTTP"
            at={[308, 130]}
            anchor="start"
          />
          <Edge
            points={[
              [388, 82],
              [480, 82],
            ]}
            marker={m.arrow}
          />
          <Edge
            points={[
              [388, 182],
              [434, 182],
              [434, 104],
              [480, 104],
            ]}
            marker={m.arrow}
          />
          <Edge
            points={[
              [388, 206],
              [560, 206],
            ]}
            marker={m.arrow}
            label="private, port 7000"
            at={[474, 194]}
          />

          <Box x={0} y={44} w={150} h={64} title="Browser" sub="anywhere" />
          <Box x={0} y={212} w={150} h={64} title="Desktop app" sub="on your Mac" />
          <Box x={212} y={44} w={176} h={60} title="web" sub="public, port 3000" />
          <Box
            x={212}
            y={156}
            w={176}
            h={76}
            title="worker"
            sub={["public for websockets,", "port 4001, one replica"]}
            tone="ink"
          />
          <Box x={480} y={44} w={248} h={60} title="Postgres" sub="private, with pgvector" />
          <Box
            x={560}
            y={156}
            w={168}
            h={76}
            title="computer"
            sub={["private, one replica,", "volume at /home"]}
            tone="ink"
          />
        </>
      )}
    </Svg>
  );
}
