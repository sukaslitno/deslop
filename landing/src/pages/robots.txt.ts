import type { APIRoute } from "astro";

const origin = process.env.SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined);
const isIndexable = Boolean(origin) && process.env.VERCEL_ENV !== "preview";

export const GET: APIRoute = () => new Response(
  isIndexable ? `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap-index.xml\n` : "User-agent: *\nDisallow: /\n",
  { headers: { "Content-Type": "text/plain; charset=utf-8" } },
);
