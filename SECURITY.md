# Security

This extension runs subagents in the same Pi process and operating-system user account. Agents share the working directory and filesystem permissions.

Tool allowlists and permission extensions are policy controls, not an OS sandbox. For untrusted tasks, run Pi inside a container, VM, or other system-level sandbox.

Child approval dialogs from loaded permission extensions are forwarded to the root TUI. In non-interactive modes, permission extensions such as `permission-gate.ts` can fail closed according to their own policy.
