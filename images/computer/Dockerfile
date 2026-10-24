# The shared computer: an XFCE desktop with Chromium, the Codex app-server and botd.
# Build from the repository root: docker build -f images/computer/Dockerfile .

FROM node:24-trixie-slim AS build
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/egress/package.json packages/egress/
COPY apps/botd/package.json apps/botd/
RUN pnpm install --frozen-lockfile --filter @open-bot/botd...
COPY packages/shared packages/shared
COPY packages/egress packages/egress
COPY apps/botd apps/botd
RUN pnpm --filter @open-bot/botd build

FROM node:24-trixie-slim

ARG CODEX_VERSION=0.162.1
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq less locales nano procps python3 python3-venv ripgrep tini unzip util-linux wget zip \
      xvfb xauth x11-utils x11-xserver-utils x11vnc xdotool scrot \
      dbus-x11 xfce4-session xfwm4 xfce4-panel xfdesktop4 xfce4-settings xfconf xfce4-terminal thunar mousepad \
      adwaita-icon-theme gnome-themes-extra \
      chromium fonts-inter fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji fonts-dejavu-core \
    && sed -i 's/# en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @openai/codex@${CODEX_VERSION} && npm cache clean --force

# Two users: `desktop` owns the screen, `bot` runs Codex and its shell without access to the display.
# Both are in the `bots` group, which owns the shared folders.
RUN userdel -r node \
    && groupadd --gid 1100 bots \
    && useradd --create-home --uid 1000 --shell /bin/bash --groups bots bot \
    && useradd --create-home --uid 1001 --shell /bin/bash --groups bots desktop

COPY images/computer/rootfs/ /
COPY images/computer/make-wallpaper.py /tmp/make-wallpaper.py
RUN mkdir -p /usr/share/backgrounds \
    && python3 /tmp/make-wallpaper.py /usr/share/backgrounds/open-bot.png \
    && rm /tmp/make-wallpaper.py \
    # The bot's shell can't use the display, so remove the desktop entries that don't belong on a shared machine.
    && rm -f /etc/xdg/autostart/xscreensaver.desktop /etc/xdg/autostart/light-locker.desktop \
       /etc/xdg/autostart/xfce4-power-manager.desktop /etc/xdg/autostart/xiccd.desktop

COPY --from=build /src/apps/botd/dist/botd.mjs /opt/botd/botd.mjs

ENV BOTS_GID=1100
EXPOSE 7000
VOLUME ["/home"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=60s --retries=3 \
  CMD curl -fsS http://127.0.0.1:7000/healthz || exit 1
ENTRYPOINT ["tini", "--", "node", "/opt/botd/botd.mjs"]
