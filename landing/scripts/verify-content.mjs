import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const [ru, en, site, releases] = await Promise.all([
  readFile(resolve(here, "../src/content/ru.ts"), "utf8"),
  readFile(resolve(here, "../src/content/en.ts"), "utf8"),
  readFile(resolve(here, "../src/config/site.ts"), "utf8"),
  readFile(resolve(here, "../src/config/releases.ts"), "utf8"),
]);

for (const [name, source] of [["ru", ru], ["en", en]]) {
  for (const key of ["header", "hero", "stats", "features", "screen", "cta", "dialog", "links", "footer"]) if (!source.includes(`${key}:`)) throw new Error(`${name} content is missing ${key}`);
}
for (const fragment of ["Не копи шлоп,", "управляй", "шлоп", "(и бесплатно!)", "тут на мобиле", "видно вообще что-то?", "А зачем качать с мобилы?", "Я хз... хочу так", "Не, ну если СИЛЬНО надо...", "Какая у вас система?", "Винда", "2026. jeneverbes"]) if (!ru.includes(fragment)) throw new Error(`Required RU copy is missing: ${fragment}`);
for (const key of ["github", "releases", "telegram", "betaChat", "donate", "author"]) if (!site.includes(`${key}:`)) throw new Error(`site config is missing ${key}`);
if (!site.includes("https://github.com/sukaslitno/verbaclean")) throw new Error("GitHub target does not match the confirmed repository");
if (!site.includes("donate: null") || !site.includes("author: null")) throw new Error("Unavailable donate/author URLs must remain explicit");
for (const asset of ["Deslop_0.1.1_aarch64.dmg", "Deslop_0.1.1_x64.dmg"]) if (!releases.includes(asset)) throw new Error(`Verified macOS asset is missing: ${asset}`);
if (releases.includes('platform: "windows"')) throw new Error("Windows installer must not be invented without a verified release asset");

console.log("Content, links, and verified installer availability match the v2 contract.");
