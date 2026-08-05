import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import process from "node:process";

import type { Logger } from "../observability/logger.js";

const FORCE_KILL_DELAY_MS = 500;

function killWindowsProcessTree(
  child: ChildProcess,
  logger: Logger,
  commandId: string,
): void {
  const pid = child.pid;
  const systemRoot = process.env["SystemRoot"] ?? process.env["WINDIR"];
  if (pid === undefined || systemRoot === undefined) {
    child.kill("SIGTERM");
    return;
  }

  const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
  try {
    const killer = spawn(taskkill, ["/pid", String(pid), "/T", "/F"], {
      detached: false,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", () => {
      child.kill("SIGTERM");
    });
    killer.once("close", (exitCode) => {
      if (exitCode !== 0 && child.exitCode === null) {
        child.kill("SIGTERM");
      }
    });
  } catch {
    logger.warn("process_tree_termination_fallback", {
      command_id: commandId,
      platform: "win32",
    });
    child.kill("SIGTERM");
  }
}

function killPosixProcessTree(
  child: ChildProcess,
  logger: Logger,
  commandId: string,
): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }

  const forceKillTimer = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      if (child.exitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          logger.warn("process_tree_force_kill_failed", {
            command_id: commandId,
            platform: process.platform,
          });
        }
      }
    }
  }, FORCE_KILL_DELAY_MS);
  forceKillTimer.unref();
}

export function terminateProcessTree(
  child: ChildProcess,
  logger: Logger,
  commandId: string,
): void {
  if (process.platform === "win32") {
    killWindowsProcessTree(child, logger, commandId);
    return;
  }
  killPosixProcessTree(child, logger, commandId);
}
