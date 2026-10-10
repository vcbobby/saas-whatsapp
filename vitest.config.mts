import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Las pruebas no dependen de tu .env.local: siempre en modo "meta" (los de simulador lo cambian a propósito).
    env: { ...loadEnv(mode, process.cwd(), ""), QUEUE_PREFIX: "test", WHATSAPP_SEND_MODE: "meta" },
    globalSetup: ["tests/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
  },
}));
