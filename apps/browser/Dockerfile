# A computer in the world: Chromium with a real (virtual) screen, not headless,
# so sites treat it like a person's browser. bridge.mjs carries the DevTools
# protocol out to Agentown over one WebSocket; nothing listens for connections.
# Build with `docker build -t agentown/browser:<version> apps/browser`.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
RUN apk add --no-cache chromium xvfb xkbcomp xkeyboard-config ttf-dejavu font-noto-cjk font-noto-emoji \
 # The root filesystem is read-only: Xvfb compiles its keymap into /tmp.
 && rm -rf /var/lib/xkb && ln -s /tmp /var/lib/xkb \
 && mkdir -p /workspace && chown 1000:1000 /workspace
COPY bridge.mjs /opt/agentown/bridge.mjs
USER 1000:1000
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/agentown/bridge.mjs"]
