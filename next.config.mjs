// @ts-check

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  cleanDistDir: true,
  typedRoutes: true,
  images: {
    unoptimized: true,
  },
  reactCompiler: true,
  experimental: {
    optimizeServerReact: true,
    optimizePackageImports: [
      "next",
      "next-mdx-remote",
      "rehype-prism-plus",
      "remark-gfm",
      "gray-matter",
      "feed",
      "@opennextjs/cloudflare",
    ],
    parallelServerCompiles: true,
    webpackBuildWorker: true,
    viewTransition: true,
  },
  /**
   * @param {import('webpack').Configuration} config
   * @returns {import('webpack').Configuration}
   */
  webpack(config) {
    if (config.output)
      config.output.trustedTypes = { policyName: "nextjs#bundler" };
    return config;
  },
};

export default nextConfig;

import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
if (process.env.NODE_ENV === "development") initOpenNextCloudflareForDev();
