import { Box, Edge, Label, Svg } from "../svg";

/** The path of one browser connection from the computer to a website. */
export function EgressDiagram() {
  const boxes = [
    { title: "Chromium", sub: ["on a screen,", "in the computer"] },
    { title: "botd", sub: ["SOCKS5 server,", "egress router"] },
    { title: "Worker", sub: ["EgressRelay:", "pairs two sockets"] },
    { title: "Desktop app", sub: ["EgressAgent,", "on your Mac"] },
    { title: "Website", sub: ["sees your", "home IP"] },
  ];
  const labels = ["SOCKS5, :1080", "WS /egress", "WS /egress/agent", "plain TCP"];
  return (
    <Svg
      height={250}
      label="Browser egress: Chromium to botd to the worker to the desktop app to the website"
    >
      {(m) => (
        <>
          {labels.map((label, i) => (
            <Edge
              key={label}
              points={[
                [i * 160 + 104, 102],
                [i * 160 + 160, 102],
              ]}
              marker={m.arrow}
              start={i === 1 || i === 2 ? m.arrow : undefined}
            />
          ))}
          <Edge
            points={[
              [208, 134],
              [208, 214],
              [676, 214],
              [676, 134],
            ]}
            marker={m.arrow}
            dashed
            muted
            label="direct, when the mode is Off, or Prefer and your Mac is offline"
            at={[442, 214]}
          />
          {boxes.map((box, i) => (
            <Box
              key={box.title}
              x={i * 160}
              y={70}
              w={104}
              h={64}
              title={box.title}
              sub={box.sub}
              tone={i === 2 ? "ink" : i === 4 ? "wash" : "sheet"}
            />
          ))}
          {labels.map((label, i) => (
            <Label key={label} x={i * 160 + 132} y={156} lines={label} mono size={11} />
          ))}
          <Label x={104} y={38} lines="the computer" weight={600} color="#14161b" />
          <Label x={372} y={38} lines="app services" weight={600} color="#14161b" />
          <Label x={532} y={38} lines="your Mac" weight={600} color="#14161b" />
          <Label x={692} y={38} lines="the internet" weight={600} color="#14161b" />
        </>
      )}
    </Svg>
  );
}
