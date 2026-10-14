# Contributing to Agentown

Thanks for your interest! Agentown is early (v0.x) and its core promise is
**permissions enforced outside the model**. Please keep that in mind: a change
that makes an agent more capable must not make it able to grant itself more.

## Getting started

Requirements: Node 22, pnpm 10, Docker, PostgreSQL 16.

```bash
pnpm install
createuser -s agentown && createdb -O agentown agentown && createdb -O agentown agentown_test
pnpm check                      # typecheck + unit/integration tests
pnpm --filter @agentown/harness image
pnpm build:web
AGENTOWN_RUNTIME_DRIVER=docker scripts/dev-server.sh
scripts/demo.sh                 # real agents, end to end
```

See `README.md` for the k3s setup and `docs/DECISIONS.md` for why things are
the way they are.

## Layout

| Path | What |
|---|---|
| `packages/core` | Domain contract: actions, scopes, policy engine, config schema |
| `apps/server` | Org service (Fastify + Postgres), runtime controller, Kubernetes/Docker drivers |
| `apps/harness` | Process inside each agent runtime, `agentown` CLI, playbooks |
| `apps/web` | 2D office UI (React + Canvas) |
| `config/agentown.yaml` | Owner-authored org config: catalog, templates, policy profiles |
| `deploy/` | One-command host installer (`install.sh`) and `agentownctl` |
| `site/` | agentown.site (GitHub Pages) |
| `scripts/package-release.sh` | Builds release assets; see `docs/RELEASING.md` |

## Pull requests

- Keep PRs focused; describe the behaviour change and how you verified it.
- `pnpm check` must pass. Add tests for new behaviour — for anything touching
  authorization, add both an **allowed** and a **denied** case.
- Changes to `packages/core/src/policy.ts`, `apps/server/src/service.ts`
  (`require`, delegation, credentials), the runtime drivers, admission/RBAC
  manifests or `config/agentown.yaml` profiles are security-sensitive: explain
  why the change cannot widen what an agent can do on its own.
- Never commit secrets. Local state lives in `.agentown/` (git-ignored).
- Code style: TypeScript strict, match the surrounding code, comments explain *why*.

## Reporting security issues

Please do **not** open a public issue — see [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
