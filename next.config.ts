import type { NextConfig } from "next";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const nextConfig: NextConfig = {
  output: "standalone",
  distDir: process.env.DAWAR_PORTABLE_BUILD === "1" ? ".next-portable" : ".next",
  poweredByHeader: false,
  skipProxyUrlNormalize: true,
  webpack(config, { webpack }) {
    // The existing Vinext/Cloudflare build remains unchanged. Only Next's
    // standalone Node target replaces Worker environment bindings.
    config.resolve.alias["cloudflare:workers"] = resolve("portable/platform.mjs");
    config.plugins.push(new webpack.NormalModuleReplacementPlugin(/^cloudflare:workers$/, resolve("portable/platform.mjs")));
    config.plugins.push(new webpack.NormalModuleReplacementPlugin(/^pdfjs-dist\/build\/pdf\.worker\.min\.mjs\?url$/, resolve("portable/pdf-worker-url.ts")));
    config.plugins.push(new webpack.NormalModuleReplacementPlugin(/^\.\/pdf-assets$/, resolve("portable/pdf-assets.ts")));
    config.resolve.extensionAlias = { ...config.resolve.extensionAlias, ".js": [".js", ".ts", ".tsx"] };
    config.plugins.push(new webpack.DefinePlugin({ __DAWAR_BUILD__: JSON.stringify(process.env.DAWAR_BUILD_ID ?? execFileSync("git",["rev-parse","--short=12","HEAD"],{encoding:"utf8"}).trim()) }));
    return config;
  },
};

export default nextConfig;
