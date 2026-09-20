import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(scriptDirectory, "../../app/src/design-system/tokens.css");
const destinationPath = resolve(scriptDirectory, "../src/design-system/generated-tokens.css");
const metadataPath = resolve(scriptDirectory, "../src/design-system/generated-tokens.meta.json");
const hash = (value) => createHash("sha256").update(value).digest("hex");

let source;
try {
  source = await readFile(sourcePath, "utf8");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  const [generated, metadata] = await Promise.all([
    readFile(destinationPath, "utf8"),
    readFile(metadataPath, "utf8").then(JSON.parse),
  ]);
  if (!generated.includes("--vc-color-aqua") || metadata.outputHash !== hash(generated)) {
    throw new Error("The materialized design tokens are missing or have failed integrity validation.");
  }
  console.warn("Shared app tokens are unavailable; using the committed, integrity-checked landing token snapshot.");
  process.exit(0);
}
const root = source.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1];

if (!root) throw new Error("Could not read the shared design-system token block.");

const output = `/* Generated from app/src/design-system/tokens.css. Source SHA-256: ${hash(source)}. Do not edit manually. */\n:root {${root}\n}\n\n.vc-corner-smooth {}\n@supports (corner-shape: superellipse(1.6)) {\n  .vc-corner-smooth { corner-shape: superellipse(1.6); }\n}\n`;
await writeFile(destinationPath, output);
await writeFile(metadataPath, `${JSON.stringify({ sourceHash: hash(source), outputHash: hash(output) }, null, 2)}\n`);
