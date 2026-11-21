import { Box, Edge, Group, Label, Svg } from "../svg";

/** Where the trust boundaries are, and what crosses each. */
export function TrustDiagram() {
  return (
    <Svg height={498} label="Trust boundaries and the credential on each connection">
      {(m) => (
        <>
          <Group x={0} y={0} w={170} h={330} label="Outside" />
          <Group x={210} y={0} w={300} h={330} label="App services" />
          <Group x={550} y={0} w={194} h={330} label="Computer" />
          <Group x={210} y={350} w={300} h={112} label="Pages origin" note="sandboxed" />

          <Edge
            points={[
              [150, 66],
              [226, 66],
            ]}
            marker={m.arrow}
            label={["session", "cookie"]}
            at={[188, 44]}
          />
          <Edge
            points={[
              [150, 90],
              [184, 90],
              [184, 196],
              [226, 196],
            ]}
            marker={m.arrow}
            label={["VNC token,", "60 s"]}
            at={[190, 142]}
            anchor="start"
          />
          <Edge
            points={[
              [150, 236],
              [196, 236],
              [196, 220],
              [226, 220],
            ]}
            marker={m.arrow}
            label={["egress token,", "120 s"]}
            at={[202, 256]}
            anchor="start"
          />
          <Edge
            points={[
              [150, 100],
              [160, 100],
              [160, 420],
              [226, 420],
            ]}
            marker={m.arrow}
            bridge
            label="page key, 10 min"
            at={[154, 396]}
            anchor="end"
          />
          <Edge
            points={[
              [326, 92],
              [326, 180],
            ]}
            marker={m.arrow}
            label="x-worker-secret"
            at={[334, 136]}
            anchor="start"
          />
          <Edge
            points={[
              [494, 208],
              [566, 208],
            ]}
            marker={m.arrow}
            label={["Bearer", "BOTD_TOKEN"]}
            at={[530, 154]}
          />

          <Box x={14} y={44} w={136} h={64} title="Your browser" sub="owner account only" />
          <Box x={14} y={204} w={136} h={64} title="Desktop app" sub="signed in as you" />
          <Box x={226} y={44} w={268} h={48} title="Web app" sub="Better Auth, one owner email" />
          <Box
            x={226}
            y={180}
            w={268}
            h={56}
            title="Worker"
            sub="holds ENCRYPTION_KEY, decrypts secrets"
            tone="ink"
          />
          <Box x={566} y={180} w={162} h={56} title="botd" sub="root, the only way in" tone="ink" />
          <Box x={566} y={258} w={162} h={56} title="Codex, shell" sub="user bot, no display" />
          <Box x={566} y={44} w={162} h={56} title="Screens" sub="user desktop" />
          <Box
            x={226}
            y={394}
            w={268}
            h={52}
            title="Pages"
            sub="no session, serves one signed version"
          />
          <Label
            x={0}
            y={482}
            anchor="start"
            lines="Postgres holds API keys, vault items, connection headers and the Telegram token, encrypted with AES-256-GCM."
          />
        </>
      )}
    </Svg>
  );
}
