# Changelog

## 0.2.0 - 2026-08-15

- Keep only `list_agents` active before delegation is requested.
- Add `list_agents(include_roles=true)` for on-demand role discovery.
- Dynamically enable collaboration tools through Pi deferred tool loading.
- Remove hard-coded role names from the `spawn_agent` schema.
- Keep the root prompt limited to capability discovery and result retrieval.

## 0.1.0 - 2026-08-15

- Initial public release.
- Persistent recursive agent tree backed by in-process Pi `AgentSession`s.
- Six Codex-style collaboration tools.
- Context forking, mailbox communication, concurrency and residency limits.
- Hidden child-session persistence and lazy reload.
- Root-TUI permission approval forwarding.
- Pull-based result retrieval with compact completion notices.
