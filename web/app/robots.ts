import type { MetadataRoute } from "next";

// output: "export" requires metadata routes to be explicitly static.
export const dynamic = "force-static";

const SITE_URL =
  process.env.APP_URL || "https://postflop-workbench.vercel.app";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
