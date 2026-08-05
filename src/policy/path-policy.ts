import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { RuntimePolicy } from "../config/schema.js";
import { PolicyRejectionError } from "./errors.js";

export function pathIsInside(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

export async function resolveWorkingDirectory(
  requestedDirectory: string | undefined,
  policy: RuntimePolicy,
): Promise<string> {
  const primaryRoot = policy.workspaceRoots[0];
  if (primaryRoot === undefined) {
    throw new PolicyRejectionError(
      "workspace_not_configured",
      "No workspace root is configured",
    );
  }

  const unresolved =
    requestedDirectory === undefined
      ? primaryRoot
      : path.isAbsolute(requestedDirectory)
        ? requestedDirectory
        : path.resolve(primaryRoot, requestedDirectory);

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(unresolved);
  } catch {
    throw new PolicyRejectionError(
      "cwd_not_found",
      "The requested working directory does not exist or cannot be resolved",
    );
  }

  let metadata;
  try {
    metadata = await stat(canonicalPath);
  } catch {
    throw new PolicyRejectionError(
      "cwd_not_found",
      "The requested working directory cannot be inspected",
    );
  }

  if (!metadata.isDirectory()) {
    throw new PolicyRejectionError(
      "cwd_not_directory",
      "The requested working directory is not a directory",
    );
  }

  if (!policy.workspaceRoots.some((root) => pathIsInside(root, canonicalPath))) {
    throw new PolicyRejectionError(
      "cwd_outside_workspace",
      "The requested working directory is outside the allowed workspace roots",
    );
  }

  return canonicalPath;
}
