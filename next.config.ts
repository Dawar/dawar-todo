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
    // Release builds start from source, never from a persisted webpack
    // snapshot. Tailwind's automatic source scan makes every top-level
    // directory (bot-bridge/, tests/, portable/, diagnostics/ ...) a context
    // dependency, so validating an earlier build's snapshot walks the whole
    // shared checkout; on 2026-10-15 that crashed in webpack's
    // FileSystemInfo._resolveContextTsh (WasmHash `length` of undefined) until
    // .next-portable/cache was moved aside. A cold portable build costs ~30 s.
    if (process.env.DAWAR_PORTABLE_BUILD === "1") config.cache = false;
    return config;
  },
};

export default nextConfig;
