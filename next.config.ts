import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // Estos paquetes cargan archivos propios (scripts Lua): no deben empaquetarse.
  serverExternalPackages: ["bullmq", "ioredis", "@huggingface/transformers", "onnxruntime-node", "sharp"],
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
