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
    // LEGAL_CONSENT=optional: las pruebas viejas crean cuentas sin marcar la casilla; las pruebas de consentimiento lo pasan a «required».
    env: { ...loadEnv(mode, process.cwd(), ""), QUEUE_PREFIX: "test", WHATSAPP_SEND_MODE: "meta", RATE_LIMIT_DISABLED: "1", LEGAL_CONSENT: "optional" },
    globalSetup: ["tests/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
  },
}));
