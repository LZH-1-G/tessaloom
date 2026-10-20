# tessaloom
An agentic cultural experimentation studio powered by Qloo.

> *Where Different Worlds Create New Possibilities.* · Built for the **Qloo Agentic Hackathon 2026** (submission deadline: October 30, 2026, 11:45 PM EDT).

> **Project status (2026-10-20):** Architecture and design phase. The application code is not implemented yet. Qloo capabilities that have not been exercised with a live event credential are marked **PENDING LIVE VALIDATION** in the documentation.

## Technical summary

Tessaloom helps independent bookstores, cafés, small venues, and community organizers design original cultural experiences. A user describes a creative challenge that involves several cultural interests. An evidence-driven agent then:

1. **Resolves** the interests into confirmed Qloo entities and tags, and asks the user when they are ambiguous.
2. **Discovers** cross-domain relationships, then weaves *collision hypotheses* (the **Cultural Collision Engine**).
3. **Tests** each hypothesis's claims against Qloo data. Deterministic evaluators grade the evidence (the **Creative Hypothesis Loop**).
4. Runs **what-if experiments** that recompute only the affected Qloo queries and report exactly what changed (the **Counterfactual Experimentation Engine**).
5. Shows everything in an **Interactive Cultural Evidence Graph** that separates Qloo data, computed values, AI interpretation, and creative speculation.
6. Composes an **experience blueprint** in which every block is either traceable to evidence or labeled as speculative.

The product has eight modules: Cultural Intelligence, Cultural Collision Engine, Creative Hypothesis Lab, Interactive Cultural Evidence Graph, What-if Experimentation Simulator, Experience Blueprint Composer, Agent Activity Monitor, and Persistent Project Workspace.

### Planned stack

| Area | Technology |
|---|---|
| App | TypeScript, Next.js (App Router), React, Tailwind CSS, shadcn/ui, React Flow, Recharts |
| Data | PostgreSQL, Drizzle ORM, Zod, pg-boss |
| Qloo | The official `@qloo/qloo-harness` (`qloo mcp` / `qloo exec` / `qloo api`), called from a long-running worker. Serverless is not a supported route for the harness. |
| AI | A provider-agnostic LLM gateway with structured outputs. The default provider is the Anthropic Claude API: primary `claude-opus-5-5`, configurable fallback `claude-sonnet-5-5`. It needs a separately funded API key; Claude Code and Codex subscriptions do not cover runtime use. |
| Quality | Vitest, Playwright, axe-core, GitHub Actions, gitleaks, CodeQL |
| Hosting | One always-on container service: a supervisor runs the web and worker processes with per-process secret isolation. Plus managed PostgreSQL. |

### Documentation

| Document | Contents |
|---|---|
| [PRD](docs/PRD.md) | Product requirements, personas, modules, scenarios |
| [Architecture](docs/ARCHITECTURE.md) | System architecture and technology decisions |
| [Agent workflow](docs/AGENT_WORKFLOW.md) | State machine, budgets, validation, counterfactual engine |
| [API contracts](docs/API_CONTRACTS.md) | Internal REST/SSE API and Qloo integration contracts |
| [Database schema](docs/DATABASE_SCHEMA.md) | Tables, relationships, versioning, retention |
| [UI/UX spec](docs/UI_UX_SPEC.md) | Screens, visual identity, accessibility |
| [Originality strategy](docs/ORIGINALITY_STRATEGY.md) | Innovation mechanisms and prior-art review |
| [Security](docs/SECURITY.md) | Security, privacy, credential management |
| [Test plan](docs/TEST_PLAN.md) | Testing strategy and acceptance criteria |
| [Implementation plan](docs/IMPLEMENTATION_PLAN.md) | Engineering milestones |
| [Hackathon checklist](docs/HACKATHON_CHECKLIST.md) | Rules and submission compliance |
| [Decisions](docs/DECISIONS.md) | Architecture decisions, trade-offs, risks |

### Responsible use

Qloo results describe **aggregate cultural affinities**. They are not evidence about any individual's identity, preferences, or future behavior. Tessaloom sends no personal data to Qloo and labels the provenance of every fact it shows.

## License

[MIT](LICENSE)
