import { Box, Edge, Svg } from "../svg";

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
            sub="sum of API key model_requests.cost_micros"
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
