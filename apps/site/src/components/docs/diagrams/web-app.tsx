import { Box, Edge, Group, Svg } from "../svg";

/** The four ways the browser reaches the Next.js server. */
export function WebAppDiagram() {
  const rows = [
    { title: "Pages", sub: "server components, first render" },
    { title: "The API", sub: "/api/rpc, every read and write" },
    { title: "Byte routes", sub: "uploads and downloads, /api/*" },
    { title: "Event stream", sub: "GET /api/stream, server-sent events" },
  ];
  return (
    <Svg height={352} label="The web app: pages, the API, byte routes and the event stream">
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
