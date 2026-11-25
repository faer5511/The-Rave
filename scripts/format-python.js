import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const venvPython = resolve(
  ".venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
const python = existsSync(venvPython)
  ? venvPython
  : process.platform === "win32"
    ? "python"
    : "python3";
const result = spawnSync(
  python,
  ["-m", "black", ...process.argv.slice(2), "app"],
  { stdio: "inherit" },
);

if (result.error) {
  console.error(`Could not run Black: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
