import path from "node:path";
import type { NextConfig } from "next";

// Pin the project root so a stray lockfile higher up the tree can't change where `output: "standalone"` is traced from.
const root = path.resolve(import.meta.dirname);

const nextConfig: NextConfig = {
  // Self-contained server for the Docker image (see Dockerfile).
  output: "standalone",
  outputFileTracingRoot: root,
  // Phones on the LAN hitting `npm run dev` by IP.
  allowedDevOrigins: ["*.local", "192.168.*.*", "10.*.*.*", "172.16.*.*"],
  turbopack: {
    root,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
