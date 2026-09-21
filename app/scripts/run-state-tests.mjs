import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const output = mkdtempSync(join(tmpdir(), "deslop-state-tests-"));
function run(args, env = process.env) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Test command exited ${result.status}`);
}
try {
  writeFileSync(join(output, "package.json"), '{"type":"module"}\n');
  run([require.resolve("typescript/lib/tsc.js"),
    "src/lib/clean-screen-state.ts", "src/lib/map-screen-state.ts", "src/lib/treemap-layout.ts", "src/lib/app-cache-name.ts",
    "src/i18n/messages/en.ts", "src/i18n/messages/ru.ts", "--target", "ES2022", "--module", "ES2022", "--moduleResolution", "bundler", "--skipLibCheck", "--outDir", output]);
  run(["--test", ...readdirSync(join(root, "scripts")).filter(name => name.endsWith(".test.mjs")).sort().map(name => join("scripts", name))], {
    ...process.env,
    DESLOP_STATE_TEST_OUTPUT: join(output, "lib"),
    DESLOP_APP_CACHE_TEST_OUTPUT: join(output, "lib"),
    DESLOP_I18N_TEST_OUTPUT: join(output, "i18n/messages"),
  });
} finally {
  rmSync(output, { recursive: true, force: true });
}
