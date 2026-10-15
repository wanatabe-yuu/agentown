# Agent runtime image: harness + agentown CLI + owner-approved playbooks.
# Build with `pnpm --filter @agentown/harness image` (bundles first).
# Pinned by digest (multi-arch index); Dependabot bumps it.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
COPY dist/harness.mjs dist/cli.mjs /opt/agentown/
COPY playbooks/ /opt/agentown/playbooks/
# git: agents with code access check out this install's source and propose diffs.
RUN apk add --no-cache git \
 && mkdir -p /workspace && chown 1000:1000 /workspace \
 && printf '#!/bin/sh\nexec node /opt/agentown/cli.mjs "$@"\n' > /usr/local/bin/agentown \
 && chmod 0755 /usr/local/bin/agentown /opt/agentown/playbooks/*.sh
USER 1000:1000
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/agentown/harness.mjs"]
