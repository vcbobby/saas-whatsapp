import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { askCopilot, MAX_HISTORY_TURNS, MAX_QUESTION_CHARS, MAX_TURN_CHARS } from "@/lib/copilot/ask";
import { withTenant } from "@/lib/db";

const schema = z.object({
  question: z.string().trim().min(2, "Escribe tu pregunta").max(MAX_QUESTION_CHARS, `Máximo ${MAX_QUESTION_CHARS} caracteres`),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(MAX_TURN_CHARS) })).max(MAX_HISTORY_TURNS).default([]),
});

/** Pregunta al copiloto del dueño (solo lectura). */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "copilot:use");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;

  const name = await withTenant(tenantId, async (db) => (await db.query("SELECT name FROM tenants WHERE id = $1", [tenantId])).rows[0]?.name as string | undefined);
  const res = await askCopilot({ tenantId, businessName: name ?? "el negocio", question: body.data.question, history: body.data.history });
  if (res.kind === "limit") return errorResponse(429, "limite_diario", "Llegaste al límite de preguntas de hoy. Mañana se renueva; mientras tanto revisa Hoy, Agenda o Pedidos.");
  if (res.kind === "unavailable") return errorResponse(503, "copiloto_no_disponible", "El copiloto no está disponible ahora. Intenta de nuevo en un momento.");
  return jsonResponse({ answer: res.answer, asOf: res.asOf, blocked: res.kind === "blocked" });
});
