# Security policy

`os-batch-mcp` is a policy enforcement layer around selected local executables. It is
not an operating-system sandbox.

Please report security issues privately to the repository owner rather than opening a
public issue. Include the affected version, platform, policy file, proof of concept,
and expected impact. Do not include live credentials or other people's data.

The supported security baseline is the current `main` branch on maintained Node.js
20-or-newer releases. A report is especially useful if it demonstrates command
allowlist bypass, shell invocation, workspace escape through `cwd`, executable
resolution hijacking, environment injection, unbounded output, or a child process
surviving cancellation.

`examples/policy.development.json` intentionally uses denylist command selection and
inherits the parent process's executable `PATH`. It is an autonomy and convenience
profile, not a security boundary: allowed runtimes, package scripts, build tools, and
other executables can invoke denied commands indirectly. Use the read-only allowlist
profile, a dedicated low-privilege account, or a container/VM for untrusted content.
