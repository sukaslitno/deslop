import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const wordmark = await sharp(resolve(here, "../public/brand/deslop-wordmark.svg"))
  .resize({ width: 574 })
  .png()
  .toBuffer();

await sharp({
  create: {
    width: 1200,
    height: 630,
    channels: 4,
    background: "#000000",
  },
})
  .composite([{ input: wordmark, left: 313, top: 242 }])
  .png({ compressionLevel: 9, palette: true })
  .toFile(resolve(here, "../public/brand/og.png"));
