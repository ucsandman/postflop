import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Fully static app; export lets the workbench deploy as plain files.
  output: "export",
};

export default nextConfig;
