import { spawnSync } from "node:child_process";
const command = process.argv[2] || "build";
const editions = process.argv[3] ? [process.argv[3]] : ["companion", "backup"];
if (!["build", "zip", "prepare"].includes(command) || editions.some(x => !["backup", "companion"].includes(x))) throw new Error("Invalid build arguments");
for (const edition of editions) {
  const result = spawnSync(process.execPath, ["node_modules/wxt/bin/wxt.mjs", command, "--browser", "chrome", "--mv3"], {
    stdio: "inherit", env: { ...process.env, TAPNOW_EDITION: edition }
  });
  if (result.status !== 0) process.exit(result.status || 1);
}
