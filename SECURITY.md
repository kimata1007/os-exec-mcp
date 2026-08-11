# Security policy

`os-exec-mcp` is a local command execution and orchestration layer. Its default policy
delegates command authorization to the MCP client and is not an operating-system
sandbox.

Please report security issues privately to the repository owner rather than opening a
public issue. Include the affected version, platform, policy file, proof of concept,
and expected impact. Do not include live credentials or other people's data.

The supported security baseline is the current `main` branch on maintained Node.js
20-or-newer releases. A report is especially useful if it demonstrates workspace
escape through `cwd`, executable resolution hijacking, environment injection,
unbounded output, limit bypass, or a tracked child process surviving cancellation.

The built-in policy intentionally permits shells, runtimes, Docker, Kubernetes tools,
package scripts, build tools, destructive commands, and network-capable executables.
It rejects only direct privilege-elevation executables. This rejection can be bypassed
indirectly by an allowed executable and must not be treated as an OS privilege
boundary. Use client-side approval and sandboxing, a dedicated low-privilege account,
or a container/VM for untrusted content. Administrators may use a custom allowlist
policy when deterministic server-side command authorization is required.
