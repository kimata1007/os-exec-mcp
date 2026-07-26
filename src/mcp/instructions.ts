export const SERVER_INSTRUCTIONS = `IMPORTANT: Batch only independent operations that have no data dependency and do not compete for the same mutable resource. Serialize operations whose write order matters, and never run multiple updates to the same file in parallel.

Prefer batching read-only repository inspection. Send argv arrays, never shell command strings. Interactive commands, stdin, TTYs, shells, privilege elevation, and background daemons are unsupported.

The default maximum batch size is 16 and the default maximum concurrency is 8; the active server policy may set lower limits. Large stdout and stderr are truncated independently, while the process pipes continue to be drained.

Use failure_mode="continue" when partial results remain useful, especially for independent read-only investigation. Use failure_mode="fail_fast" only when the remaining work becomes invalid after one failure; in-flight commands may be cancelled and already completed side effects are never rolled back.

The server enforces workspace roots, executable and subcommand allowlists, environment-variable restrictions, per-command timeouts, and output limits. Rejected commands should be changed rather than retried unchanged.`;
