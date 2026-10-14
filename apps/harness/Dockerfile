# Agent runtime image: harness + agentown CLI + owner-approved playbooks.
# Build with `pnpm --filter @agentown/harness image` (bundles first).
# Pinned by digest (multi-arch index); Dependabot bumps it.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
COPY dist/harness.mjs dist/cli.mjs /opt/agentown/
COPY playbooks/ /opt/agentown/playbooks/
RUN mkdir -p /workspace && chown 1000:1000 /workspace \
 && printf '#!/bin/sh\nexec node /opt/agentown/cli.mjs "$@"\n' > /usr/local/bin/agentown \
 && chmod 0755 /usr/local/bin/agentown /opt/agentown/playbooks/*.sh
USER 1000:1000
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/agentown/harness.mjs"]
