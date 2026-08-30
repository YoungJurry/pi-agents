# Codex-style Agents for Pi

In-process persistent multi-agent collaboration modeled after OpenAI Codex MultiAgentV2.

## Install

```bash
pi install git:github.com/YoungJurry/pi-agents
```

Then start Pi or run `/reload` in an existing session.

> This extension runs child agents with the same OS user and filesystem permissions as the root Pi process. Review [SECURITY.md](./SECURITY.md) before using it on untrusted work.

## Quick start

Ask Pi to delegate work:

```text
Spawn two agents to research independent parts of this task, wait for completion,
then pull and summarize their results.
```

The model queries `list_agents(view="tools")` for the action catalog and, when needed, `list_agents(view="roles")` for role-specific configuration. It executes catalog actions through the compact `agent_action` dispatcher.

Completion notices are intentionally small. Full answers enter the parent context only when explicitly requested with `list_agents(view="results")`.

## Inspect sub-agent sessions

Use the user-only `/agents` command to browse the current root session's sub-agents and open a read-only transcript:

```text
/agents
/agents /root/api_research
```

The picker shows lifecycle status, model, role, nickname, and residency. Selecting an agent opens its active session branch with normal Pi-style assistant messages, thinking, tool calls, tool results, and collaboration messages. Custom tools reuse their original Pi renderers, so tools such as `web_search` and `fetch` stay as compact as they are in the main transcript. Running sessions refresh while the viewer is open.

Viewer controls:

- `↑` / `↓`, `PageUp` / `PageDown`, `Home` / `End`: scroll
- `Ctrl+O`: expand or collapse tool output
- `Ctrl+T`: show or hide thinking
- `r`: refresh immediately
- `Escape`: return to the agent picker

This inspector is implemented only as a slash command and TUI overlay. It does not register an LLM tool, alter tool schemas or system prompts, add messages to the root context, switch sessions, wake agents, or expose child sessions through the normal `/resume` picker.

## Tools

Only two compact collaboration schemas remain active:

- `list_agents`: query one catalog or data view
  - `roles`: available roles and their tool access
  - `tools`: action descriptions and parameter schemas
  - `status`: canonical agent-tree status
  - `results`: stored final answers
- `agent_action`: execute a catalog action by name with its matching arguments

`list_agents(view="tools")` returns these actions as ordinary tool-result content instead of activating more provider tool schemas:

- `spawn_agent`: spawn a persistent child `AgentSession`
- `send_message`: non-waking mailbox message
- `followup_task`: assign more work and trigger processing
- `wait_agent`: event-driven mailbox wait
- `interrupt_agent`: abort a run without deleting context

Example dispatcher call:

```json
{
  "action": "spawn_agent",
  "arguments": {
    "message": "Research the API implementation",
    "task_name": "api_research",
    "agent_type": "explorer"
  }
}
```

The five action implementations stay registered locally, but their individual provider schemas are never added to later requests. Root and child agents use the same stable `list_agents` + `agent_action` surface. Agents use canonical paths such as `/root/api_research` and can recursively spawn children.

## Context inheritance

The `spawn_agent` action's `fork_turns` argument accepts:

- `none`: fresh context
- `all`: sanitized semantic parent context (default)
- a positive integer string: the most recent N task/user turns

Tool calls, tool results, thinking, shell transcripts, and previous collaboration mail are removed from inherited context.

## Roles

Built-ins: `default`, `explorer`, `awaiter`.

Additional roles are read from:

- `~/.pi/agent/agents/*.md`
- nearest trusted `.pi/agents/*.md`

Role format:

```markdown
---
name: reviewer
description: Review code without editing
tools: read, grep, find, ls, bash
model: openai/gpt-5.4
thinking: high
nickname_candidates: [Ada, Grace]
---

Review carefully and return findings with exact paths.
```

## Model configuration

Global sub-agent settings live outside the installed package so updates cannot overwrite them:

`~/.pi/agent/codex-agents/agents-setting.json`

```json
{
  "defaultModel": "opencode-go/ox-alpha-free"
}
```

Model selection uses this precedence:

1. The `spawn_agent` action's `model` argument
2. The selected role's `model` frontmatter
3. `agents-setting.json`'s `defaultModel`
4. The parent agent's active model

The settings file is optional. Invalid JSON, an empty `defaultModel`, or an unavailable configured model produces an explicit error. `fork_turns` controls inherited messages independently of model selection.

## Lifecycle

- Default child execution slots: 3 (4 active agents including root)
- Default resident child sessions: 3
- Completed/interrupted sessions are unloaded by LRU when residency is full
- Child sessions persist under `~/.pi/agent/codex-agents/roots/<root-session-id>/sessions/` and reload lazily
- Full final answers persist under `~/.pi/agent/codex-agents/roots/<root-session-id>/results/`
- Each root storage group records its owning main-session file in `owner.json`
- Resuming an existing main session removes groups whose owning main-session file has been deleted; new sessions and `/reload` do not trigger cleanup
- Referenced legacy flat child files are migrated when their main session is resumed
- Parents receive a compact completion notice instead of the full answer; use `list_agents(view="results")` or read the result file on demand
- Notices to a busy agent are queued safely: `wait_agent` returns them in its own result, and any leftovers are delivered right after a successful recipient turn
- Failed notice delivery is re-queued instead of silently discarded
- Notices pending when a turn is aborted or errors are deferred to the next explicit turn without restarting the interrupted agent
- The extension never inserts messages between an assistant tool call and its tool result, keeping session history protocol-valid for strict gateways
- Child sessions are kept out of Pi's normal `/resume` picker
- Agent-tree metadata persists in root session custom entries
- Child extension approval dialogs are serialized and forwarded to the root TUI with the agent path
- In non-interactive modes, permission extensions such as `permission-gate.ts` fail closed
- All agents share the same cwd and filesystem

Use `/agents` to browse the tree and inspect read-only child transcripts. A compact live tree appears below the editor while child agents exist and shows each active agent's `provider/model` identifier.
