import { randomInt, randomUUID } from "node:crypto";
import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { encryptSecret } from "@/lib/crypto";
import { withTenant } from "@/lib/db";
import { devToolsEnabled, getSendMode } from "@/lib/env";
import { enqueueInbound } from "@/lib/queue/producer";
import { ingestBatch } from "@/lib/whatsapp/ingest";

/**
 * SIMULADOR DE WHATSAPP (solo desarrollo). Permite chatear con tu propio asistente sin Meta, sin túnel
 * y sin token. El mensaje entra por la MISMA ruta real: ingesta → cola → agente → respuesta.
 * Fuera de local/test responde 404 como si no existiera.
 */
const SIM_CUSTOMER = "584120000001"; // cliente inventado

const notFound = () => errorResponse(404, "no_encontrado", "No encontrado.");

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("send"), text: z.string().trim().min(1, "Escribe un mensaje").max(1000, "Máximo 1000 caracteres") }),
  z.object({ action: z.literal("reset") }),
]);

export const GET = route(async (req) => {
  if (!devToolsEnabled()) return notFound();
  const auth = await requireTenant(req, "agent:manage");
  if (!auth.ok) return auth.response;
  const tenantId = auth.ctx.tenantId;

  const data = await withTenant(tenantId, async (db) => {
    const agent = await db.query<{ enabled: boolean }>("SELECT enabled FROM tenant_agents WHERE tenant_id = $1", [tenantId]);
    const wa = await db.query("SELECT 1 FROM tenant_integrations WHERE provider = 'whatsapp'");
    const conv = await db.query<{ id: string; status: string; handoff_reason: string | null }>(
      `SELECT c.id, c.status, c.handoff_reason FROM conversations c
         JOIN contacts ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contact_id
        WHERE ct.wa_id = $1 AND c.status <> 'closed' ORDER BY c.created_at DESC LIMIT 1`,
      [SIM_CUSTOMER],
    );
    const c = conv.rows[0];
    const msgs = c
      ? await db.query(
          `SELECT id, direction, msg_type, body, send_state, send_error, process_state, received_at
             FROM messages WHERE tenant_id = $1 AND conversation_id = $2 ORDER BY received_at DESC, id DESC LIMIT 60`,
          [tenantId, c.id],
        )
      : { rows: [] };
    return {
      agentEnabled: agent.rows[0]?.enabled ?? false,
      whatsappReady: wa.rowCount === 1,
      conversation: c ? { status: c.status, handoffReason: c.handoff_reason } : null,
      messages: msgs.rows.reverse(),
    };
  });
  return jsonResponse({ sendMode: getSendMode(), ...data });
});

export const POST = route(async (req) => {
  if (!devToolsEnabled()) return notFound();
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "agent:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, bodySchema);
  if (!body.ok) return body.response;
  const tenantId = auth.ctx.tenantId;

  if (body.data.action === "reset") {
    await withTenant(tenantId, (db) =>
      db.query(
        `UPDATE conversations SET status = 'closed'
          WHERE tenant_id = $1 AND status <> 'closed'
            AND contact_id IN (SELECT id FROM contacts WHERE tenant_id = $1 AND wa_id = $2)`,
        [tenantId, SIM_CUSTOMER],
      ),
    );
    return jsonResponse({ ok: true });
  }

  // Número al que "escribe" el cliente simulado: el del negocio o, en modo simulación, uno falso.
  let phoneId = await currentPhoneId(tenantId);
  if (!phoneId) {
    if (getSendMode() !== "simulate") {
      return errorResponse(409, "sin_numero", "Conecta un número de WhatsApp, o activa WHATSAPP_SEND_MODE=simulate en .env.local para usar un número de prueba.");
    }
    phoneId = await createFakeNumber(tenantId);
  }

  const result = await ingestBatch({
    phoneNumberId: phoneId,
    statuses: [],
    messages: [{ waId: SIM_CUSTOMER, name: "Cliente de prueba", waMessageId: `wamid.SIMIN.${randomUUID()}`, at: new Date(), type: "text", body: body.data.text }],
  });
  try {
    await enqueueInbound(result.inbound);
  } catch (err) {
    // Igual que el webhook real: el mensaje ya está guardado y el barrendero lo recupera.
    console.error("[simulador] no se pudo encolar:", err instanceof Error ? err.message : err);
  }
  return jsonResponse({ ok: true }, 201);
});

async function currentPhoneId(tenantId: string): Promise<string | null> {
  return withTenant(tenantId, async (db) => {
    const r = await db.query<{ external_id: string }>("SELECT external_id FROM tenant_integrations WHERE provider = 'whatsapp'");
    return r.rows[0]?.external_id ?? null;
  });
}

/** Número inventado (solo existe en tu base local) para poder probar sin conectar nada con Meta. */
async function createFakeNumber(tenantId: string): Promise<string> {
  for (let i = 0; i < 3; i++) {
    const phoneId = "99" + String(randomInt(0, 1e12)).padStart(12, "0");
    const { payload, keyVersion } = encryptSecret("SIMULADO", `wa:${tenantId}:${phoneId}`);
    try {
      await withTenant(tenantId, (db) =>
        db.query(
          "INSERT INTO tenant_integrations (tenant_id, provider, external_id, secret_enc, key_version) VALUES ($1, 'whatsapp', $2, $3, $4)",
          [tenantId, phoneId, payload, keyVersion],
        ),
      );
      return phoneId;
    } catch (err) {
      if ((err as { code?: string }).code !== "23505") throw err;
      // Otra petición creó el número a la vez, o el id chocó: se lee el que quedó.
      const existing = await currentPhoneId(tenantId);
      if (existing) return existing;
    }
  }
  throw new Error("No se pudo crear el número de prueba");
}
