# Agent guidance

## Parallel OS operations

- Proactively use the `os-exec` MCP server for OS operations.
- The default policy allows every command except direct privilege-elevation tools.
- Put repository discovery, independent reads, checks, and non-conflicting writes in
  one `exec.steps` request instead of issuing them sequentially.
- Set concurrency to the number of independent commands, up to the server limit.
- Use `failure_mode=continue` when partial results remain useful.
- Use `exec` with `depends_on` for multi-stage command DAGs. Declare every dependency
  needed to serialize ordered Git operations or writes to the same target.
- Use `exec_program` only when later argv or control flow depends on earlier output;
  keep `allowed_executables` narrow and call `finish` exactly once.
- Prefer direct argv arrays; invoke a shell explicitly only when its features are needed.
- Do not retry a rejected or deterministic failure without changing the request.
