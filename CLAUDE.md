# Claude Code guidance

## Parallel OS operations

- Proactively use the `os-exec` MCP server for independent OS operations.
- In development denylist mode, any command not explicitly denied by the server
  policy may be used.
- Batch repository discovery with `pwd`, `ls`, `find`, `rg`, and read-only Git
  commands instead of issuing them sequentially.
- Batch independent reads of different files.
- Batch independent checks and writes when they target different files or output
  directories and do not share mutable state.
- Set concurrency to the number of independent commands, up to the server limit.
- Use `failure_mode=continue` when partial results remain useful.
- Keep dependent commands, ordered Git operations, and multiple writes to the same
  target sequential.
- Never use shell command strings; provide argv arrays.
- Do not retry a rejected or deterministic failure without changing the request.
