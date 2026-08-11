export const SERVER_INSTRUCTIONS = `Use exec to submit all immediately-ready commands and dependency-ordered commands in one validated graph. Declare each command as a step with an argv array; add depends_on only for real data or mutation dependencies. Ready steps run concurrently within both the request limit and a server-wide process limit.

Use exec_program when later argv values or control flow depend on earlier command output and expressing the operation as a static DAG would require extra model turns. Programs run in isolated QuickJS with only exec, parallel, lines, and finish. Call finish exactly once with the small JSON value that should be returned. Every executable must appear in allowed_executables and still pass normal server policy.

Prefer direct argv execution over a shell when both are practical. Interactive commands, stdin, and TTYs are unsupported. Direct privilege-elevation commands are denied. Detached processes are not tracked after their parent exits. Prefer output.mode="compact"; request debug only when detailed process metadata is necessary.

Use failure_mode="continue" when independent branches remain useful and fail_fast only when remaining work is invalid after one failure. Rejected commands should be changed rather than retried unchanged.`;
