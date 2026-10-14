# Agent runtime image: harness + agentown CLI + owner-approved playbooks.
# Build with `pnpm --filter @agentown/harness image` (bundles first).
# Pinned by digest (multi-arch index); Dependabot bumps it.
FROM node:26-alpine@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a
COPY dist/harness.mjs dist/cli.mjs /opt/agentown/
COPY playbooks/ /opt/agentown/playbooks/
RUN mkdir -p /workspace && chown 1000:1000 /workspace \
 && printf '#!/bin/sh\nexec node /opt/agentown/cli.mjs "$@"\n' > /usr/local/bin/agentown \
 && chmod 0755 /usr/local/bin/agentown /opt/agentown/playbooks/*.sh
USER 1000:1000
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/agentown/harness.mjs"]
