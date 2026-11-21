import { Edge, Label, State, Svg } from "../svg";

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
