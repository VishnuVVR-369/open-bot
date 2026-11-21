import { Box, Edge, Group, Svg } from "../svg";

/** A cloud deployment: five services in one private network, plus the Mac. */
export function DeploymentDiagram() {
  return (
    <Svg
      height={352}
      label="Cloud deployment: web, pages and the worker public, Postgres and the computer private"
    >
      {(m) => (
        <>
          <Group x={180} y={0} w={564} h={340} label="One project, one private network" />
          <Edge
            points={[
              [136, 66],
              [212, 66],
            ]}
            marker={m.arrow}
            label="HTTPS"
            at={[174, 54]}
          />
          <Edge
            points={[
              [136, 88],
              [166, 88],
              [166, 182],
              [212, 182],
            ]}
            marker={m.arrow}
            label={["WSS", "/vnc"]}
            at={[172, 137]}
            anchor="start"
          />
          <Edge
            points={[
              [136, 244],
              [196, 244],
              [196, 206],
              [212, 206],
            ]}
            marker={m.arrow}
            label="WSS /egress/agent"
            at={[202, 250]}
            anchor="start"
          />
          <Edge
            points={[
              [136, 100],
              [152, 100],
              [152, 296],
              [212, 296],
            ]}
            marker={m.arrow}
            bridge
            label="HTTPS"
            at={[182, 284]}
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
              [388, 66],
              [480, 66],
            ]}
            marker={m.arrow}
          />
          <Edge
            points={[
              [388, 182],
              [434, 182],
              [434, 90],
              [480, 90],
            ]}
            marker={m.arrow}
          />
          <Edge
            points={[
              [388, 206],
              [560, 206],
            ]}
            marker={m.arrow}
            label={["private,", "port 7000"]}
            at={[460, 206]}
          />
          <Edge
            points={[
              [388, 296],
              [520, 296],
              [520, 104],
            ]}
            marker={m.arrow}
            bridge
          />

          <Box x={0} y={44} w={136} h={64} title="Browser" sub="anywhere" />
          <Box x={0} y={212} w={136} h={64} title="Desktop app" sub="on your Mac" />
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
          <Box x={212} y={268} w={176} h={56} title="pages" sub="public, a domain of its own" />
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
