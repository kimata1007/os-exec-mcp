# Repository-to-Pages benchmark task

Work autonomously in the current empty directory. Do not ask the user questions.

Create a complete, responsive TypeScript task-board application named
**Focus Board**. It must support:

- adding, completing, filtering, and deleting tasks;
- persistence in `localStorage`;
- keyboard-accessible controls and visible focus states;
- responsive layouts for mobile and desktop;
- automated unit tests for the state-management logic;
- formatting, linting, TypeScript checking, tests, and a production build;
- a concise README with local development and deployment instructions.

Use a conventional, actively supported TypeScript web toolchain. Pin dependency
versions through a lockfile. The production build must be committed under `/docs`
and include a `.nojekyll` file so GitHub Pages can publish it directly. Ensure the
deployed `docs/index.html` contains this exact benchmark marker:

```html
<meta name="os-batch-benchmark" content="{{RUN_ID}}" />
```

Initialize a Git repository with the default branch `main`. Create the public
GitHub repository `{{OWNER}}/{{REPOSITORY_NAME}}`, commit the complete application,
and push `main`.

Configure GitHub Pages using branch publishing, with `main` and `/docs` as the
source and the legacy build type. Do not create or use a GitHub Actions workflow.
The expected repository and site are:

- Repository: {{REPOSITORY_URL}}
- Site: {{PAGE_URL}}

If an OS batch MCP tool is available, use it only for independent commands that
are safe to run concurrently. Do not force dependent or mutating operations to run
in parallel.

Before finishing:

1. Run formatting checks, lint, TypeScript checking, unit tests, and the production
   build successfully.
2. Confirm the pushed repository is public and `main` contains `/docs`.
3. Confirm GitHub Pages is configured for `main:/docs`.
4. Poll the public site until it returns HTTP 200 and its HTML contains
   `{{RUN_ID}}`.

Do not delete the repository or deployment. Report the repository URL, Pages URL,
checks run, and any retries.
