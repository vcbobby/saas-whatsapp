import { getWhatsAppEnv } from "@/lib/env";
import { errorResponse, route } from "@/lib/auth/http";
import { ingestBatch } from "@/lib/whatsapp/ingest";
import { parseWebhook } from "@/lib/whatsapp/payload";
import { readRawBody, safeEqualText, verifySignature } from "@/lib/whatsapp/signature";

const MAX_BODY = 1_000_000; // 1 MB: los webhooks reales pesan unos pocos KB

const plain = (text: string, status = 200) =>
  new Response(text, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

/** Meta llama aquí UNA vez al registrar el webhook para comprobar que es tuyo. */
export const GET = route(async (req) => {
  const env = getWhatsAppEnv();
  const q = new URL(req.url).searchParams;
  const challenge = q.get("hub.challenge") ?? "";
  const ok =
    q.get("hub.mode") === "subscribe" &&
    safeEqualText(q.get("hub.verify_token") ?? "", env.WHATSAPP_VERIFY_TOKEN) &&
    /^[A-Za-z0-9_-]{1,200}$/.test(challenge);
  return ok ? plain(challenge) : plain("Forbidden", 403);
});

/** Mensajes y estados. Primero se comprueba la firma; sin firma válida no se toca nada. */
export const POST = route(async (req) => {
  const env = getWhatsAppEnv();
  const raw = await readRawBody(req, MAX_BODY);
  if (!raw) return errorResponse(413, "cuerpo_muy_grande", "Petición demasiado grande.");

  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"), env.WHATSAPP_APP_SECRET)) {
    console.warn("[webhook] firma inválida: revisa que WHATSAPP_APP_SECRET sea el de tu app de Meta");
    return errorResponse(401, "firma_invalida", "Firma inválida.");
  }

  let json: unknown;
  try {
    json = JSON.parse(raw.toString("utf8"));
  } catch {
    return errorResponse(400, "json_invalido", "JSON inválido.");
  }
  const batches = parseWebhook(json);
  if (!batches) return plain("ignored"); // formato que no es de mensajes: 200 para que Meta no reintente

  // Si algo falla aquí, route() responde 500 y Meta reintenta; el índice único evita duplicados.
  for (const batch of batches) {
    const r = await ingestBatch(batch);
    if (r.unknownNumber) {
      console.warn(`[webhook] llegó un mensaje para el número ${batch.phoneNumberId}, que no está conectado a ningún negocio`);
    }
  }
  return plain("ok");
});
