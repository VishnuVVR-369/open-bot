import { Box, Edge, Svg } from "../svg";

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
            sub={["teammates: a job, instructions,", "autonomy and model"]}
            tone="ink"
          />
          <Box
            x={287}
            y={20}
            w={170}
            h={64}
            title="Chat"
            sub={["direct or group,", "or a hidden helper chat"]}
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
