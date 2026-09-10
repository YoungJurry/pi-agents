# Codex-style Agents for Pi

In-process persistent multi-agent collaboration modeled after OpenAI Codex MultiAgentV2.

## Install

Install the public npm package:

```bash
pi install npm:@youngjurry/pi-agents
```

Or install directly from GitHub:

```bash
pi install git:github.com/YoungJurry/pi-agents
```

Choose only one source to avoid loading the extension twice. Then start Pi or run `/reload` in an existing session.

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

The picker orders agents by latest task assignment, newest first; a successful `followup_task` moves a reused agent back to the top without letting ordinary streaming or tool activity reshuffle the list. It shows lifecycle status, model, effective thinking level, role, nickname, and residency. Selecting an agent opens its active session branch with normal Pi-style assistant messages, thinking, tool calls, tool results, and collaboration messages. Custom tools reuse their original Pi renderers, so tools such as `web_search` and `fetch` stay as compact as they are in the main transcript. Running sessions refresh while the viewer is open. Child permission dialogs wait behind the inspector and appear only after the user fully exits `/agents`, so they cannot steal focus from or hide behind its overlay.

Viewer controls:

- `↑` / `↓`: move one line
- `←` / `→`: move one page up or down
- `t` / `b`: jump to the top or bottom
- `Ctrl+O`: expand or collapse tool output
- `Ctrl+T`: show or hide thinking
- `r`: refresh immediately
- `Escape`: return to the agent picker

This inspector is implemented only as a slash command and TUI overlay. It does not register an LLM tool, alter tool schemas or system prompts, add messages to the root context, switch sessions, wake agents, or expose child sessions through the normal `/resume` picker.

## Usage accounting

Pi's built-in `/session` remains the authoritative view of the main Agent and its cache behavior. Use the user-only command below for separately calculated main, sub-agent, and combined totals:

```text
/agent-usage
```

The command writes a detailed report directly into the normal TUI transcript, like `/session`; it does not open an overlay. The report includes main, sub-agent, and combined input/output/cache/token/cost totals, followed by separate main-model and sub-agent-model breakdowns. Each model row shows its tokens, prompt/output/cache details, number of contributing Agent sessions, and number of usage records. Non-model tool and summary usage is kept in an explicit `Tools/summaries` bucket rather than being misattributed to a model.

The report is stored as a TUI-only custom entry so it remains outside LLM context and does not affect `/session` message or token accounting. Reading the report does not load or wake child AgentSessions. Pi currently has no extension hook that can add child tokens to built-in `/session` while excluding them from that command's cache statistics.

## Tools

Only two compact collaboration schemas remain active:

- `list_agents`: query one catalog or data view
  - `roles`: available roles and their tool access
  - `tools`: action descriptions and parameter schemas
  - `status`: canonical agent-tree status
  - `results`: stored final answers
- `agent_action`: execute a catalog action by name with its matching arguments

`list_agents(view="tools")` returns these actions as ordinary tool-result content instead of activating more provider tool schemas:

- `spawn_agents`: submit one or many persistent child tasks in a single action; overflow waits in the visible FIFO queue
- `send_message`: non-waking mailbox message
- `followup_task`: assign more work and trigger processing
- `wait_agent`: event-driven mailbox wait
- `interrupt_agent`: abort a run without deleting context

Example dispatcher call:

```json
{
  "action": "spawn_agents",
  "arguments": {
    "agents": [
      {
        "message": "Research the API implementation",
        "task_name": "api_research",
        "agent_type": "explorer"
      },
      {
        "message": "Inspect the test strategy",
        "task_name": "test_research",
        "agent_type": "explorer"
      }
    ]
  }
}
```

The five action implementations stay registered locally, but their individual provider schemas are never added to later requests. `spawn_agents` replaces the old single-task action rather than adding a redundant sixth action; an array with one item performs a single spawn. Root and child agents use the same stable `list_agents` + `agent_action` surface. Agents use canonical paths such as `/root/api_research` and can recursively spawn children.

## Context inheritance

Each item in the `spawn_agents` action accepts a `fork_turns` argument:

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
skills: [document]
model: openai/gpt-5.4
thinking: high
nickname_candidates: [Ada, Grace]
---

Review carefully and return findings with exact paths.
```

`skills` optionally filters Pi's normal progressive Skill disclosure. Omit the field to inherit all discoverable Skills, specify names such as `skills: [document]` to expose only those Skill names/descriptions/paths, or use `skills: []` to expose none. The child still reads a matching `SKILL.md` on demand rather than placing complete Skill instructions in every prompt. As in Pi's main Agent, the catalog is shown only when `read` or `bash` is active. Unknown explicitly selected Skill names fail clearly instead of being silently ignored.

## Model configuration

Global sub-agent settings live outside the installed package so updates cannot overwrite them:

`~/.pi/agent/pi-agents/settings.json`

```json
{
  "defaultModel": "opencode-go/ox-alpha-free",
  "defaultThinkingLevel": "medium",
  "maxConcurrentSubagents": 3,
  "maxResidentSubagents": 3
}
```

Model and thinking configuration uses task fields first, then Role frontmatter, then global settings. Parent Agent model and thinking state are never used as implicit fallbacks.

| Task override | Effective selection |
|---|---|
| `model` and `reasoning_effort` | Use both explicit values |
| `model` only | Use that model and its highest supported thinking level |
| `reasoning_effort` only | Use the Role/global model with the explicit thinking level |
| neither | Use Role values where present, then `defaultModel` and `defaultThinkingLevel` |

Unsupported thinking values are clamped through Pi's model-specific `thinkingLevelMap`, and the effective level is persisted and displayed. If `defaultThinkingLevel` is omitted, the plugin-level default is `medium`. Supported configured values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

The settings file is optional, but spawning requires a model from either the task, selected Role, or `defaultModel`; it no longer inherits the parent model. Limits must be positive integers, and `maxResidentSubagents` cannot be smaller than `maxConcurrentSubagents`. If concurrency is configured while residency is omitted, residency automatically expands to at least the concurrency limit. Setting changes take effect after `/reload`. Invalid JSON, an invalid `defaultThinkingLevel`, an empty `defaultModel`, or an unavailable configured model produces an explicit error. `fork_turns` controls inherited messages independently of model and thinking selection.

## Lifecycle

- Default child execution slots: 3 (4 active agents including root), configurable with `maxConcurrentSubagents`
- Default resident child sessions: 3, configurable with `maxResidentSubagents`
- `spawn_agents` starts tasks until all execution slots are occupied and records the remainder as `queued`
- Queued tasks are lightweight, persistent, FIFO ordered, and do not occupy resident-session capacity
- Queued session identity, child ownership metadata, and sanitized fork context are durably written before the batch spawn returns
- `list_agents(view="status")` reports each waiting task's queue position plus current running/queued capacity
- The live widget shows `Agents active: <running>/<limit> · queued: <waiting>` and labels waiting paths explicitly
- Completed/interrupted sessions are unloaded by LRU when residency is full
- Child sessions persist under `~/.pi/agent/pi-agents/roots/<root-session-id>/sessions/` and reload lazily
- Full final answers persist under `~/.pi/agent/pi-agents/roots/<root-session-id>/results/`
- Each root storage group records its owning main-session file in `owner.json`
- The extension reads and writes only `~/.pi/agent/pi-agents/` and `settings.json`; it contains no automatic legacy migration, archival, or deletion logic
- Resuming an existing main session removes groups whose owning main-session file has been deleted; new sessions and `/reload` do not trigger grouped cleanup
- Parents receive a compact completion notice instead of the full answer; use `list_agents(view="results")` or read the result file on demand
- Notices to a busy agent are queued safely: `wait_agent` returns them in its own result, and any leftovers are delivered right after a successful recipient turn
- `wait_agent` sends only newly queued mailbox notices to the model; its child status tree excludes the active caller, is folded in the TUI by default, and can be toggled with `Ctrl+O`
- Failed notice delivery is re-queued instead of silently discarded
- Notices pending when a turn is aborted or errors are deferred to the next explicit turn without restarting the interrupted agent
- The extension never inserts messages between an assistant tool call and its tool result, keeping session history protocol-valid for strict gateways
- Child sessions are kept out of Pi's normal `/resume` picker
- Agent-tree metadata persists in root session custom entries
- Child extension approval dialogs are serialized and forwarded to the root TUI with the agent path
- While `/agents` is open, forwarded permission/custom dialogs wait without taking keyboard focus and appear only after the inspector closes
- In non-interactive modes, permission extensions such as `permission-gate.ts` fail closed
- All agents share the same cwd and filesystem

Use `/agents` to browse the tree and inspect read-only child transcripts. A compact live tree appears below the editor while child agents exist and shows each active agent's `provider/model` identifier and effective thinking level.

## Manual migration from versions before 0.10.0

Version 0.10.0 removes all runtime compatibility code for the former `codex-agents` names. Existing users who cannot see an old Agent tree, or who still have `~/.pi/agent/codex-agents/` or `agents-setting.json`, should **close every Pi process first** and run the following command once. It renames the storage/settings paths and updates the old custom-entry identifiers and persisted file paths in main and child session JSONL files. It refuses to merge conflicting old and new paths automatically.

```bash
python3 - <<'PY'
from pathlib import Path
import json
import os
import stat

agent_dir = Path.home() / ".pi" / "agent"
old_root = agent_dir / "codex-agents"
new_root = agent_dir / "pi-agents"

if old_root.exists():
    if new_root.exists():
        raise SystemExit(
            f"Refusing to merge because both {old_root} and {new_root} exist. "
            "Back them up and reconcile them manually first."
        )
    old_root.rename(new_root)

old_settings = new_root / "agents-setting.json"
new_settings = new_root / "settings.json"
if old_settings.exists():
    if new_settings.exists():
        raise SystemExit(
            f"Refusing to overwrite {new_settings}; reconcile it with {old_settings} manually."
        )
    old_settings.rename(new_settings)

custom_types = {
    "codex-agents": "pi-agents",
    "codex-agents-state": "pi-agents-state",
    "codex-agents-child-meta": "pi-agents-child-meta",
    "codex-agents-fork-context": "pi-agents-fork-context",
}
old_prefix = str(old_root)
new_prefix = str(new_root)


def migrate(value):
    changed = False
    if isinstance(value, dict):
        output = {}
        for key, child in value.items():
            if key == "customType" and isinstance(child, str) and child in custom_types:
                output[key] = custom_types[child]
                changed = True
            elif key in {"sessionFile", "resultFile"} and isinstance(child, str) and (
                child == old_prefix or child.startswith(old_prefix + os.sep)
            ):
                output[key] = new_prefix + child[len(old_prefix):]
                changed = True
            else:
                output[key], child_changed = migrate(child)
                changed |= child_changed
        return output, changed
    if isinstance(value, list):
        output = []
        for child in value:
            migrated, child_changed = migrate(child)
            output.append(migrated)
            changed |= child_changed
        return output, changed
    return value, False

files = set((agent_dir / "sessions").rglob("*.jsonl"))
if new_root.exists():
    files.update(new_root.rglob("*.jsonl"))

changed_files = 0
for file in sorted(files):
    temporary = file.with_name(file.name + ".pi-agents-migrate")
    touched = False
    try:
        with file.open("r", encoding="utf-8") as source, temporary.open("w", encoding="utf-8") as target:
            for line in source:
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    target.write(line)
                    continue
                value, line_changed = migrate(value)
                target.write(
                    json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n"
                    if line_changed else line
                )
                touched |= line_changed
        if touched:
            os.chmod(temporary, stat.S_IMODE(file.stat().st_mode))
            os.replace(temporary, file)
            changed_files += 1
        else:
            temporary.unlink()
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise

print(f"Migration complete: updated {changed_files} JSONL file(s). Restart Pi or run /reload.")
PY
```

Fresh installations do not need this command.
