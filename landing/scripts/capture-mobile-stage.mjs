import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const landing = path.join(root, "landing");
const label = process.env.QA_LABEL;
const sectionSelector = process.env.QA_SECTION;
const mobileDialog = process.env.QA_DIALOG === "mobile";
const origin = process.env.LANDING_URL ?? "http://127.0.0.1:4321";
const widths = (process.env.QA_WIDTHS ?? "390,1440").split(",").map(Number);

if (!label || !/^[a-z0-9-]+$/.test(label)) throw new Error("QA_LABEL must use lowercase letters, digits, and hyphens.");
if (!sectionSelector) throw new Error("QA_SECTION must select the implemented section.");

const sha = (value) => createHash("sha256").update(value).digest("hex");
async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(entryPath));
    if (entry.isFile()) files.push(entryPath);
  }
  return files;
}
async function fingerprint() {
  const files = new Set();
  for (const directory of ["src", "public", "scripts", "tests"]) for (const file of await walk(path.join(landing, directory))) files.add(file);
  for (const name of await readdir(landing)) {
    const file = path.join(landing, name);
    if ((await stat(file)).isFile() && ([".json", ".mjs", ".ts", ".yaml", ".yml"].includes(path.extname(file)) || [".npmrc", ".nvmrc"].includes(name))) files.add(file);
  }
  files.add(path.join(root, "app/src/design-system/tokens.css"));
  const rows = await Promise.all([...files].sort().map(async (file) => ({ path: path.relative(root, file), sha256: sha(await readFile(file)) })));
  return { algorithm: "SHA256 of sorted SHA256 + two spaces + repository-relative path + LF", sourceFingerprint: sha(rows.map((row) => `${row.sha256}  ${row.path}\n`).join("")), files: rows };
}

const output = path.join(root, "docs/landing-v2-mobile/qa/implementation", label);
await mkdir(output, { recursive: true });
const before = await fingerprint();
const browser = await chromium.launch();
const results = [];
try {
  for (const width of widths) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors = [], failed = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    page.on("requestfailed", (request) => failed.push({ url: request.url(), failure: request.failure() }));
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map((image) => image.decode().catch(() => null)));
    });
    const section = page.locator(sectionSelector);
    if (await section.count() !== 1) throw new Error(`Expected exactly one ${sectionSelector} section.`);
    await section.screenshot({ path: path.join(output, `ru-${width}-section.png`) });
    await page.screenshot({ path: path.join(output, `ru-${width}-viewport.png`) });
    let dialog = null;
    if (mobileDialog) {
      if (width > 767) throw new Error("QA_DIALOG=mobile only supports a mobile viewport.");
      await page.locator("[data-download-trigger]").first().click();
      const describeDialog = () => page.evaluate(() => {
        const box = (selector) => document.querySelector(selector)?.getBoundingClientRect().toJSON();
        return {
          title: document.querySelector("#download-dialog-title")?.innerText,
          panel: box(".download-dialog__inner"),
          choicesHidden: document.querySelector("[data-download-choices]")?.hidden,
          continueHidden: document.querySelector("[data-mobile-continue]")?.hidden,
          active: document.activeElement?.id,
        };
      });
      const intro = await describeDialog();
      await page.screenshot({ path: path.join(output, `ru-${width}-dialog-intro.png`) });
      await page.locator("[data-mobile-continue]").click();
      const platforms = await describeDialog();
      await page.screenshot({ path: path.join(output, `ru-${width}-dialog-platforms.png`) });
      dialog = { intro, platforms };
    }
    const evidence = await page.evaluate((selector) => {
      const box = (element) => element.getBoundingClientRect().toJSON();
      const section = document.querySelector(selector);
      return {
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
        section: section ? box(section) : null,
        images: [...(section?.querySelectorAll("img") ?? [])].map((image) => ({ src: image.currentSrc, width: image.naturalWidth, height: image.naturalHeight, complete: image.complete })),
        fonts: [...document.fonts].map((font) => ({ family: font.family, weight: font.weight, style: font.style, status: font.status })),
      };
    }, sectionSelector);
    await writeFile(path.join(output, `ru-${width}-evidence.json`), JSON.stringify({ origin, selector: sectionSelector, evidence, errors, failed }, null, 2) + "\n");
    results.push({ width, evidence, errors, failed, dialog });
    await context.close();
  }
} finally {
  await browser.close();
}
const after = await fingerprint();
const summary = { label, origin, selector: sectionSelector, before, after, stableDuringCapture: before.sourceFingerprint === after.sourceFingerprint, results };
await writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify({
  label,
  origin,
  selector: sectionSelector,
  sourceFingerprint: before.sourceFingerprint,
  stableDuringCapture: summary.stableDuringCapture,
  results: results.map(({ width, errors, failed, evidence }) => ({ width, document: evidence.document, errors, failed })),
}, null, 2));
