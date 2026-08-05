export const SERVER_INSTRUCTIONS = `IMPORTANT: Proactively batch all independent operations that have no data dependency and do not compete for the same mutable resource. Independent reads should normally be issued together, especially repository discovery with ls, find, rg, git status, and git log. Independent writes to different files or output directories may also run concurrently. Serialize operations whose write order matters, and never run multiple updates to the same file or shared mutable resource in parallel.

Use batch_exec when every command is immediately ready. Use workflow_exec when commands form multiple dependency stages: declare direct predecessor IDs in depends_on and submit the entire acyclic workflow once. workflow_exec runs ready nodes concurrently. In continue mode, a failed node blocks only its descendants; independent branches continue. In fail_fast mode, any non-success stops the whole workflow.

Send argv arrays, never shell command strings. Interactive commands, stdin, TTYs, shells, privilege elevation, destructive deletion, and background daemons are unsupported.

The default maximum batch size and maximum concurrency are both 16; concurrency defaults to 8. The active server policy may set lower limits. Large stdout and stderr are truncated independently, while the process pipes continue to be drained.

An allowlist policy permits only configured executables. A denylist policy permits every executable found in its trusted or inherited PATH except commands named in deniedCommands or the server's built-in shell and privilege-elevation denylist.

Use failure_mode="continue" when partial results remain useful, especially for independent repository inspection and verification. Use failure_mode="fail_fast" only when the remaining work becomes invalid after one failure; in-flight commands may be cancelled and already completed side effects are never rolled back.

The server enforces workspace roots, command selection policy, environment-variable restrictions, per-command timeouts, and output limits. Rejected commands should be changed rather than retried unchanged.`;
