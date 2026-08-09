# Agent guidance

## Parallel OS operations

- Proactively use the `os-exec` MCP server for OS operations.
- In development denylist mode, any command not explicitly denied by the server
  policy may be used.
- Put repository discovery, independent reads, checks, and non-conflicting writes in
  one `exec.steps` request instead of issuing them sequentially.
- Set concurrency to the number of independent commands, up to the server limit.
- Use `failure_mode=continue` when partial results remain useful.
- Use `exec` with `depends_on` for multi-stage command DAGs. Declare every dependency
  needed to serialize ordered Git operations or writes to the same target.
- Use `exec_program` only when later argv or control flow depends on earlier output;
  keep `allowed_executables` narrow and call `finish` exactly once.
- Never use shell command strings; provide argv arrays.
- Do not retry a rejected or deterministic failure without changing the request.
