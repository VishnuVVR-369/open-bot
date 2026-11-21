import { Box, Edge, Svg } from "../svg";

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
