import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../public/landing-v2/assets/screen-img.png");
const target = resolve(here, "../public/landing-v2/mobile");

await mkdir(target, { recursive: true });
for (const width of [342, 684, 1026]) {
  await sharp(source)
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: 85, effort: 6 })
    .toFile(resolve(target, `screen-results-${width}.webp`));
}
