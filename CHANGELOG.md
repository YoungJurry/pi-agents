# Changelog

## 0.3.0 - 2026-08-15

- Replace session-persistent deferred schemas with a stable `agent_action` dispatcher.
- Add `list_agents(view="roles" | "tools" | "status" | "results")` and remove boolean view flags.
- Return the five action descriptions and parameter schemas only from the `tools` catalog view.
- Keep individual action implementations locally registered without exposing their provider schemas.
- Use the same compact gateway surface for root and child agents.

## 0.2.1 - 2026-08-15

- Reduce the root prompt to a single delegation capability sentence.
- Move role discovery, tool activation, and result retrieval guidance into `list_agents` parameter descriptions.
- Show discovered roles and enabled tools in the `list_agents` TUI result.
- Label `list_agents` calls as roles, results, or status instead of always showing `all`.

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
