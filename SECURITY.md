# Security Policy

Agentown runs AI agents with real credentials and real compute. Its security
model is documented in `README.md` (permission model) and `docs/DECISIONS.md`.

## Supported versions

Agentown is pre-1.0. Only the latest `main` receives fixes.

## Reporting a vulnerability

Please report privately using GitHub's **"Report a vulnerability"** button
(Security → Advisories) on this repository. Do not open a public issue or PR.

Include what an attacker controls (e.g. an agent's model output, an agent
token, a task spec, an API client), the steps, and the impact. We aim to
acknowledge within 7 days.

Especially in scope:

- an agent (or a model acting through it) gaining a permission it was not
  granted: spawning outside its templates, exec/control outside its scope,
  self-granting, escaping delegation limits;
- reading another agent's data, artifacts, logs or API key;
- escaping an agent runtime, or making the controller create a workload the
  catalog/admission policy should reject;
- API keys, agent tokens or terminal tickets leaking into logs, events, audit
  or API responses;
- acting with a replaced runtime generation, or replaying a terminal ticket.

Out of scope: the Docker driver's documented weaker isolation (it has no
admission layer), and deployments that expose the API without TLS against the
README's advice.
