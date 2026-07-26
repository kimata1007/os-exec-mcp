import { chmod } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";

if (process.platform !== "win32") {
  await chmod(new URL("../dist/mcp/stdio.js", import.meta.url), 0o755);
}
