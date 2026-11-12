import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const output = path.resolve("artifacts/private/companion-types");
await fs.mkdir(output, { recursive: true });
const baseline = await fs.mkdtemp(path.join(output, "baseline-"));
const ref = execFileSync("git", ["rev-parse", process.env.TAPNOW_TYPE_BASELINE || "be4a05d76e0b781f2bc97f309f9be6da96196d7f"], { encoding: "utf8" }).trim();
const args = [
  "--noEmit", "--target", "ES2022", "--module", "ESNext",
  "--moduleResolution", "Bundler", "--lib", "ES2023,DOM,DOM.Iterable",
  "--skipLibCheck", ".wxt/wxt.d.ts", "entrypoints/tapnow.content.ts",
  "utils/tapnow-dom.ts", "utils/tapnow-route.ts"
];

function check(cwd) {
  const result = spawnSync("./node_modules/.bin/tsc", args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (![0, 2].includes(result.status)) throw new Error(result.stderr || result.stdout);
  const text = result.stdout + result.stderr;
  const diagnostics = [...text.matchAll(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/gm)]
    .map((match) => ({ file: match[1], line: Number(match[2]), column: Number(match[3]), code: match[4], message: match[5] }));
  return { exitCode: result.status, text, diagnostics };
}

function prepare(cwd) {
  execFileSync(process.execPath, ["node_modules/wxt/bin/wxt.mjs", "prepare"], {
    cwd, env: { ...process.env, TAPNOW_EDITION: "companion" }, stdio: "pipe"
  });
}

function difference(left, right) {
  const unmatched = [...right];
  return left.filter((item) => {
    const index = unmatched.findIndex((peer) => peer.file === item.file && peer.code === item.code && peer.message === item.message);
    if (index < 0) return true;
    unmatched.splice(index, 1);
    return false;
  });
}

try {
  const archive = execFileSync("git", ["archive", ref], { maxBuffer: 32 * 1024 * 1024 });
  const extract = spawnSync("tar", ["-x", "-C", baseline], { input: archive });
  assert.equal(extract.status, 0, extract.stderr?.toString());
  await fs.symlink(path.join(root, "node_modules"), path.join(baseline, "node_modules"), "dir");
  // WXT auto-import declarations contain absolute source paths. Generate each
  // tree's own declarations so the baseline cannot pull in candidate modules.
  prepare(baseline);
  const baselineEmptyModules = [];
  for (const file of ["utils/tapnow-dom.ts", "utils/tapnow-route.ts"]) {
    try {
      await fs.access(path.join(baseline, file));
    } catch {
      // These new root files have no baseline implementation to type-check.
      // Empty generated modules allow the original explicit-root command on both trees.
      await fs.writeFile(path.join(baseline, file), "export {};\n");
      baselineEmptyModules.push(file);
    }
  }
  const before = check(baseline);
  prepare(root);
  const after = check(root);
  const normalizeLocations = (text) => text.replace(/\(\d+,\d+\): error /g, "(LINE,COLUMN): error ");
  await fs.writeFile(path.join(output, "baseline.txt"), before.text);
  await fs.writeFile(path.join(output, "candidate.txt"), after.text);
  const report = {
    baselineCommit: ref,
    typescript: execFileSync("./node_modules/.bin/tsc", ["--version"], { encoding: "utf8" }).trim(),
    command: `./node_modules/.bin/tsc ${args.join(" ")}`,
    sharedDependencies: true,
    wxtDeclarations: "generated independently with the same companion prepare command",
    baselineEmptyModules,
    identicalFullDiagnosticsIgnoringLocations: normalizeLocations(before.text) === normalizeLocations(after.text),
    baseline: { exitCode: before.exitCode, diagnostics: before.diagnostics },
    candidate: { exitCode: after.exitCode, diagnostics: after.diagnostics },
    added: difference(after.diagnostics, before.diagnostics),
    removed: difference(before.diagnostics, after.diagnostics)
  };
  await fs.writeFile(path.join(output, "comparison.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.added.length ? 1 : 0;
} finally {
  await fs.rm(baseline, { recursive: true, force: true });
}
