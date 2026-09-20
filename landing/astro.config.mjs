import { defineConfig } from "astro/config";

// Vercel currently truncates larger static responses when the request host is
// www.deslop.ru. Keep the public document on its canonical domain, but fetch
// build assets from the same production deployment's stable Vercel hostname.
const assetOrigin = "https://deslop-landing.vercel.app";
const productionUrl = process.env.VERCEL_ENV === "production"
  ? "https://www.deslop.ru"
  : process.env.SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined);

export default defineConfig({
  output: "static",
  site: productionUrl,
  build: {
    assetsPrefix: assetOrigin,
  },
  devToolbar: { enabled: false },
  vite: {
    server: {
      fs: {
        allow: [".."],
      },
    },
  },
});
