# Changelog

## 0.7.0 - 2026-09-01

- Add validated global `defaultThinkingLevel` configuration with an internal `medium` default.
- Remove implicit inheritance from the parent Agent's active model and thinking level.
- Apply task overrides before Role settings and global settings; an explicit model without `reasoning_effort` now selects that model's highest supported level.
- Clamp requested and configured levels through Pi's model-specific thinking capabilities and persist the effective value.
- Show effective thinking level alongside the model in the live tree, `/agents` picker/transcript, completion rendering, status output, and non-TUI inspection.
- Defer forwarded child permission and custom dialogs while `/agents` is open, preserving inspector keyboard focus and showing queued dialogs only after the inspector exits.

## 0.6.0 - 2026-08-31

- Replace the single-task `spawn_agent` action with one non-redundant `spawn_agents` action whose `agents` array accepts either one or many tasks.
- Start tasks up to the configured execution limit and persist overflow tasks in an explicit FIFO `queued` state.
- Automatically start queued tasks as slots become available without blocking the parent tool call.
- Report `queued` status, queue position, and running/queued capacity through `list_agents(view="status")`, action results, the live widget, and `/agents`.
- Allow queued agents to receive persistent messages and be cancelled without loading an `AgentSession`.
- Restore waiting work after main-session resume while interrupted running work remains interrupted.
- Add `maxConcurrentSubagents` and `maxResidentSubagents` settings with validated positive-integer values.
- Keep exactly five catalog actions and the same two provider-facing gateway schemas.

## 0.5.3 - 2026-08-31

- Align transcript navigation with `/tree`: `↑`/`↓` move by line and `←`/`→` move by page.
- Add distinct single-key jumps: `t` for the top and `b` for the bottom.
- Remove duplicate `PageUp`/`PageDown` and `Home`/`End` aliases from the transcript viewer.

## 0.5.2 - 2026-08-30

- Show each active sub-agent's full `provider/model` identifier in the live tree below the editor.
- Preserve terminal-width truncation for long model names.

## 0.5.1 - 2026-08-30

- Reuse each child session's original custom tool renderers in the read-only transcript viewer.
- Match the main transcript's compact `web_search`, `fetch`, and other extension-tool presentation instead of dumping raw tool content.
- Cache renderer definitions across child-session unloading and discover them without waking or loading a child when viewing restored sessions.

## 0.5.0 - 2026-08-30

- Turn `/agents` into an interactive, user-only sub-agent session browser.
- Add read-only Pi-style transcript viewing for assistant output, thinking, tool calls, tool results, and collaboration messages.
- Support `/agents <path>` direct opening and agent-path argument completion.
- Refresh running transcripts without switching, waking, or loading child sessions.
- Keep the inspector out of all model-facing prompts, messages, and tool schemas.

## 0.4.1 - 2026-08-15

- Remove test-only dependencies from the published package manifest so Pi Git installs stay dependency-free.
- Keep test tooling isolated in temporary development environments.

## 0.4.0 - 2026-08-15

- Replace vague root guidance with Codex-derived parallel speed/quality criteria while keeping bounded-task guidance in the on-demand action catalog.
- Move the default child model from source code to `~/.pi/agent/codex-agents/agents-setting.json`.
- Resolve models by spawn override, role override, global setting, then parent-model inheritance.
- Decouple model selection from `fork_turns` history inheritance.
- Re-queue failed notification flushes instead of dropping them.
- Defer queued mail after aborted or errored turns without automatically restarting the recipient.
- Add regression tests for prompt separation, settings validation and precedence, notification ordering, abort behavior, and flush recovery.

## 0.3.2 - 2026-08-15

- Queue inter-agent notifications while the recipient's turn is active instead of appending into the live message tree.
- Fix assistant(tool_calls) → user → tool history corruption that caused gateway 400 errors on strict providers.
- Deliver queued completion notices inside `wait_agent` results.
- Flush remaining queued notices at turn end and wake the recipient to process them.

## 0.3.1 - 2026-08-15

- Group child sessions and results under their owning root session ID.
- Record the root session file in each storage group's `owner.json`.
- Remove orphaned storage groups only when an existing main session is resumed.
- Migrate the resumed main session's referenced legacy child files into its group.

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
