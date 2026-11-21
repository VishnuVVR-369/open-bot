import { Edge, State, Svg } from "../svg";

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
