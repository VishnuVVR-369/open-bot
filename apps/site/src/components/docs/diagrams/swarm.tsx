import { Box, Edge, Label, Svg } from "../svg";

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
