import { Box, Edge, Svg } from "../svg";

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
            sub="teammate_threads (chat, teammate)"
          />
          <Box
            x={0}
            y={100}
            w={260}
            h={56}
            title="Same tools and memory?"
            sub="Tools revision, memory generation"
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
