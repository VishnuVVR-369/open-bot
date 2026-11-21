import { Box, Edge, Group, Label, Svg } from "../svg";

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
