import { Box, Label, Svg } from "../svg";

/** The binary frame format of the egress tunnel. */
export function FrameDiagram() {
  return (
    <Svg height={132} label="An egress frame: one byte type, four byte stream id, then the payload">
      {() => (
        <>
          <Box x={0} y={10} w={140} h={64} title="type" sub="1 byte" tone="ink" mono />
          <Box x={140} y={10} w={210} h={64} title="stream id" sub="4 bytes, big endian" mono />
          <Box x={350} y={10} w={394} h={64} title="payload" sub="0 to 64 KiB" tone="wash" mono />
          <Label
            x={0}
            y={98}
            anchor="start"
            lines="1 Open {host, port} · 2 OpenOk · 3 OpenFail · 4 Data · 5 End (half close) · 6 Reset · 7 Window"
            mono
            size={11.25}
            color="#14161b"
          />
          <Label
            x={0}
            y={120}
            anchor="start"
            lines="Text messages on the same socket carry JSON control: config, peer-up, peer-down."
            mono
            size={11.25}
            color="#14161b"
          />
        </>
      )}
    </Svg>
  );
}
