# A computer in the world: Chromium with a real (virtual) screen, not headless,
# so sites treat it like a person's browser. bridge.mjs carries the DevTools
# protocol out to Agentown over one WebSocket; nothing listens for connections.
# Build with `docker build -t agentown/browser:<version> apps/browser`.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
# ffmpeg (x264): the screen as H.264 video. wireproxy: WireGuard in user space (a VPN
# without root or a tun device), offered to Chromium as a SOCKS5 proxy.
ARG WIREPROXY=https://github.com/windtf/wireproxy/releases/download/v1.1.3/wireproxy_linux_amd64.tar.gz
ARG WIREPROXY_SHA256=e88c1d090740373fc606c1bafd81d9a5eadc642cce5667616e20e9d7a444f51c
RUN apk add --no-cache chromium xvfb xkbcomp xkeyboard-config ttf-dejavu font-noto-cjk font-noto-emoji ffmpeg \
 # The root filesystem is read-only: Xvfb compiles its keymap into /tmp.
 && rm -rf /var/lib/xkb && ln -s /tmp /var/lib/xkb \
 && wget -qO /tmp/wireproxy.tgz "$WIREPROXY" \
 && echo "$WIREPROXY_SHA256  /tmp/wireproxy.tgz" | sha256sum -c - \
 && tar -xzf /tmp/wireproxy.tgz -C /usr/local/bin wireproxy && rm /tmp/wireproxy.tgz \
 && mkdir -p /workspace && chown 1000:1000 /workspace
# The terminal app: bash in a real terminal (`script` makes one), and a few everyday tools.
RUN apk add --no-cache bash util-linux-misc ncurses curl git
# xterm.js for the terminal app, from the npm tarball (its published sha512 is TQwDdQGt…MOYg==), served by bridge.mjs itself.
ARG XTERM=https://registry.npmjs.org/@xterm/xterm/-/xterm-6.0.0.tgz
ARG XTERM_SHA256=908e66e04af6c8dc6b00dd3b54de088e2e81e5ed866284fd6c2fb3c2d1c7a3f6
RUN mkdir -p /opt/agentown/xterm \
 && wget -qO /tmp/xterm.tgz "$XTERM" \
 && echo "$XTERM_SHA256  /tmp/xterm.tgz" | sha256sum -c - \
 && tar -xzf /tmp/xterm.tgz -C /opt/agentown/xterm --strip-components=1 package/lib/xterm.js package/css/xterm.css \
 && rm /tmp/xterm.tgz
# Input as a person's: mouse and keys on the screen itself (the browser's bar, menus, extensions).
RUN apk add --no-cache xdotool
COPY bridge.mjs /opt/agentown/bridge.mjs
USER 1000:1000
# Chromium needs a writable home; the root filesystem is read-only.
ENV HOME=/workspace/home
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/agentown/bridge.mjs"]
