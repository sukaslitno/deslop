import type { APIRoute } from "astro";

const origin = process.env.SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined);
const isIndexable = Boolean(origin) && process.env.VERCEL_ENV !== "preview";

export const GET: APIRoute = () => new Response(
  isIndexable
    ? `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url><url><loc>${origin}/en/</loc></url></urlset>`
    : "<?xml version=\"1.0\" encoding=\"UTF-8\"?><urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\" />",
  { headers: { "Content-Type": "application/xml; charset=utf-8" } },
);
