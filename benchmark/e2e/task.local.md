# Local application benchmark task

Work autonomously in the current empty directory. Do not ask the user questions.

Create a complete, responsive TypeScript task-board application named
**Focus Board**. It must support:

- adding, completing, filtering, and deleting tasks;
- persistence in `localStorage`;
- keyboard-accessible controls and visible focus states;
- responsive layouts for mobile and desktop;
- automated unit tests for the state-management logic;
- formatting, linting, TypeScript checking, tests, and a production build;
- a concise README with local development instructions.

Use a conventional, actively supported TypeScript web toolchain. Pin dependency
versions through a lockfile. Write the production build under `/docs` and include a
`.nojekyll` file. Ensure `docs/index.html` contains this exact benchmark marker:

```html
<meta name="os-batch-benchmark" content="{{RUN_ID}}" />
```

Initialize a Git repository with the default branch `main` and commit the complete
application locally.

The assigned benchmark mode is `{{MODE}}`. In `baseline` mode, run OS commands
normally. In `mcp` mode, proactively use the `os-batch` MCP tool for independent
repository discovery, reads, checks, and non-conflicting writes. Use at least one real
batch of independent commands. Keep dependent operations and writes to the same target
sequential.

Before finishing:

1. Run formatting checks, lint, TypeScript checking, unit tests, and the production
   build successfully.
2. Confirm the local `main` commit contains `/docs`, including `.nojekyll`.
3. Confirm `docs/index.html` contains the exact `{{RUN_ID}}` marker.

Do not create a remote repository. Do not run `gh`. Do not add a Git remote and do not
push anything. Report the checks run and any retries.
