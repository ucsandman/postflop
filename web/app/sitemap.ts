import type { MetadataRoute } from "next";

// output: "export" requires metadata routes to be explicitly static.
export const dynamic = "force-static";

const SITE_URL =
  process.env.APP_URL || "https://postflop-workbench.vercel.app";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${SITE_URL}/`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
  ];
}
