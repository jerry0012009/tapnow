import { spawnSync } from "node:child_process";
import { readFileSync, copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const command = process.argv[2] || "build";
const editions = process.argv[3] ? [process.argv[3]] : ["companion", "backup"];
if (!["build", "zip", "prepare"].includes(command) || editions.some(x => !["backup", "companion"].includes(x))) throw new Error("Invalid build arguments");
for (const edition of editions) {
  const result = spawnSync(process.execPath, ["node_modules/wxt/bin/wxt.mjs", command, "--browser", "chrome", "--mv3"], {
    stdio: "inherit", env: { ...process.env, TAPNOW_EDITION: edition }
  });
  if (result.status !== 0) process.exit(result.status || 1);
  if (command === "zip") {
    const archive = `.output/${edition}/${pkg.name}-${pkg.version}-chrome.zip`;
    const extract = args => {
      const result = spawnSync("unzip", args, { maxBuffer: 32 * 1024 * 1024 });
      if (result.status !== 0) throw new Error(`Cannot inspect ${archive}: ${result.stderr}`);
      return result.stdout;
    };
    const manifest = JSON.parse(extract(["-p", archive, "manifest.json"]));
    if (manifest.version !== pkg.version) throw new Error("Release version mismatch");
    // Publish only the ZIP just built, and compare every entry with the build output.
    const files = extract(["-Z", "-1", archive]).toString().trim().split("\n").filter(name => !name.endsWith("/"));
    for (const file of files) {
      const actual = extract(["-p", archive, file]);
      if (!actual.equals(readFileSync(path.join(`.output/${edition}/chrome-mv3`, file)))) {
        throw new Error(`Stale release entry: ${file}`);
      }
    }
    mkdirSync("releases", { recursive: true });
    const target = `releases/tapnow-${edition}-${pkg.version}-chrome.zip`;
    copyFileSync(archive, target);
    console.log(`Release ZIP checked against ${files.length} build files: ${target}`);
  }
}
