# Codex-style Agents for Pi

In-process persistent multi-agent collaboration modeled after OpenAI Codex MultiAgentV2.

## Install

```bash
pi install git:github.com/smithyyang/pi-codex-agents
```

Then start Pi or run `/reload` in an existing session.

> This extension runs child agents with the same OS user and filesystem permissions as the root Pi process. Review [SECURITY.md](./SECURITY.md) before using it on untrusted work.

## Quick start

Ask Pi to delegate work, or let the model call `spawn_agent` directly:

```text
Spawn two agents to research independent parts of this task, wait for completion,
then pull and summarize their results.
```

Completion notices are intentionally small. Full answers enter the root context only when explicitly requested with `list_agents(include_results=true)`.

## Tools

- `spawn_agent`: spawn a child `AgentSession`
- `send_message`: non-waking mailbox message
- `followup_task`: assign more work and trigger processing
- `wait_agent`: event-driven mailbox wait
- `interrupt_agent`: abort a run without deleting context
- `list_agents`: inspect the canonical agent tree

Agents use canonical paths such as `/root/api_research` and can recursively spawn children.

## Context inheritance

`spawn_agent.fork_turns` accepts:

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

## Lifecycle

- Default child model: `opencode/deepseek-v4-flash-free`
- `spawn_agent.model` or a role-level `model` can override it
- Default child execution slots: 3 (4 active agents including root)
- Default resident child sessions: 3
- Completed/interrupted sessions are unloaded by LRU when residency is full
- Child sessions persist under `~/.pi/agent/codex-agents/sessions/` and reload lazily
- Full final answers persist under `~/.pi/agent/codex-agents/results/`
- Parents receive a compact completion notice instead of the full answer; use `list_agents(include_results=true)` or read the result file on demand
- Child sessions are kept out of Pi's normal `/resume` picker
- Agent-tree metadata persists in root session custom entries
- Child extension approval dialogs are serialized and forwarded to the root TUI with the agent path
- In non-interactive modes, permission extensions such as `permission-gate.ts` fail closed
- All agents share the same cwd and filesystem

Use `/agents` for the full tree. A compact live tree appears below the editor while child agents exist.
