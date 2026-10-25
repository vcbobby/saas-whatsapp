import { describe, expect, it } from "vitest";
import { explainAiError, runAiCheck } from "@/lib/ai/check";
import { LlmError, type LlmProvider } from "@/lib/ai/provider";

const ok = (text: string): LlmProvider => ({ name: "t", generate: async () => ({ text, inputTokens: 20, outputTokens: 7, model: "m" }) });
const fail = (e: unknown): LlmProvider => ({ name: "t", generate: async () => { throw e; } });

describe("comprobador de IA (npm run ai:check)", () => {
  it("respuesta buena: devuelve texto, tokens y tiempo", async () => {
    const r = await runAiCheck(ok("  Conexión correcta: azul  "));
    expect(r).toMatchObject({ ok: true, text: "Conexión correcta: azul", inputTokens: 20, outputTokens: 7, model: "m" });
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });
  it("respuesta vacía: no cuenta como éxito", async () => {
    const r = await runAiCheck(ok("   "));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/sin texto/);
  });
  it("explica cada error en palabras sencillas y nunca filtra la clave", async () => {
    const casos: Array<[number, RegExp]> = [[400, /LLM_MODEL/], [401, /LLM_API_KEY/], [403, /LLM_API_KEY/], [404, /LLM_MODEL/], [429, /límite/], [503, /temporal/]];
    for (const [status, re] of casos) {
      const r = await runAiCheck(fail(new LlmError("Gemini respondió con error " + status, status === 429 || status >= 500, status)));
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(re);
      expect(r.message).not.toMatch(/AIza|sk-|key=/i);
    }
    expect(explainAiError(new LlmError("No se pudo contactar al proveedor de IA", true))).toBe("No se pudo contactar al proveedor de IA");
    expect(explainAiError("raro")).toBe("Error desconocido");
    expect((await runAiCheck(fail(new Error("boom")))).message).toBe("boom");
  });
});
