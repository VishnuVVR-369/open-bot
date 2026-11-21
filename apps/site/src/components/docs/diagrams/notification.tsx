import { Box, Edge, Svg } from "../svg";

/** One notification, delivered to every channel. */
export function NotificationDiagram() {
  return (
    <Svg height={232} label="A notification fans out to open tabs, push and Telegram">
      {(m) => (
        <>
          <Edge
            points={[
              [180, 116],
              [214, 116],
              [214, 50],
              [262, 50],
            ]}
            marker={m.arrow}
          />
          <Edge
            points={[
              [214, 116],
              [214, 172],
              [262, 172],
            ]}
            marker={m.arrow}
          />
          <Edge
            points={[
              [482, 50],
              [556, 50],
            ]}
            marker={m.arrow}
          />
          <Edge
            points={[
              [482, 172],
              [520, 172],
              [520, 116],
              [556, 116],
            ]}
            marker={m.arrow}
          />
          <Edge
            points={[
              [520, 172],
              [556, 172],
            ]}
            marker={m.arrow}
          />
          <Edge
            points={[
              [520, 172],
              [520, 220],
              [556, 220],
            ]}
            marker={m.arrow}
          />

          <Box
            x={0}
            y={84}
            w={180}
            h={64}
            title="createNotification()"
            sub={["a run finished or failed,", "an approval, a request"]}
            tone="ink"
          />
          <Box
            x={262}
            y={20}
            w={220}
            h={60}
            title="notifications row"
            sub="then NOTIFY openbot_app"
          />
          <Box
            x={262}
            y={142}
            w={220}
            h={60}
            title="worker event"
            sub="events.emit('notification')"
            mono
          />
          <Box
            x={556}
            y={20}
            w={188}
            h={60}
            title="Open tabs"
            sub="inbox, toast, OS notification"
          />
          <Box x={556} y={92} w={188} h={48} title="Web Push" sub="every subscribed device" />
          <Box x={556} y={148} w={188} h={48} title="Telegram" sub="the linked chat" />
          <Box x={556} y={200} w={188} h={32} title="Electron, natively" />
        </>
      )}
    </Svg>
  );
}
