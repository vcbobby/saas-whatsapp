import { z } from "zod";

// Forma de lo que envía Meta (solo lo que usamos). Lo demás se ignora.
const envelope = z.looseObject({
  object: z.string(),
  entry: z
    .array(
      z.looseObject({
        changes: z
          .array(
            z.looseObject({
              field: z.string(),
              value: z.looseObject({
                metadata: z.looseObject({ phone_number_id: z.string() }).optional(),
                contacts: z
                  .array(z.looseObject({ wa_id: z.string(), profile: z.looseObject({ name: z.string().optional() }).optional() }))
                  .optional(),
                messages: z
                  .array(z.looseObject({ from: z.string(), id: z.string(), timestamp: z.string(), type: z.string() }))
                  .optional(),
                statuses: z
                  .array(z.looseObject({ id: z.string(), status: z.string(), timestamp: z.string().optional() }))
                  .optional(),
              }),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});

export interface InboundMessage {
  waId: string;
  name: string | null;
  waMessageId: string;
  at: Date;
  type: string;
  body: string | null;
  /** Imagen recibida: id de Meta para descargarla después y su tipo (solo JPG, PNG o WebP). */
  mediaId?: string | null;
  mediaMime?: string | null;
}
export interface StatusUpdate {
  waMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  at: Date;
}
export interface TenantBatch {
  phoneNumberId: string;
  messages: InboundMessage[];
  statuses: StatusUpdate[];
}

export const MAX_ITEMS = 200;

const clean = (s: string, max: number) => s.replace(/\u0000/g, "").slice(0, max);

/** Fecha de Meta (segundos Unix). Si es absurda (futuro o muy vieja) se usa "ahora". */
export function metaDate(ts: string | undefined, now = Date.now()): Date {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return new Date(now);
  const ms = n * 1000;
  if (ms > now + 5 * 60_000 || ms < now - 30 * 86_400_000) return new Date(now);
  return new Date(ms);
}

const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Id y tipo de una imagen del mensaje; null si no es una imagen utilizable. */
function imageOf(m: Record<string, unknown>): { mediaId: string; mediaMime: string } | null {
  if (m.type !== "image") return null;
  const part = m.image as Record<string, unknown> | undefined;
  if (!part || typeof part !== "object") return null;
  const id = part.id, mime = typeof part.mime_type === "string" ? part.mime_type.toLowerCase().split(";")[0]!.trim() : "";
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(id) || !IMAGE_MIMES.has(mime)) return null;
  return { mediaId: id, mediaMime: mime };
}

function bodyOf(m: Record<string, unknown>): string | null {
  const part = m[m.type as string] as Record<string, unknown> | undefined;
  const pick = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  if (!part || typeof part !== "object") return null;
  switch (m.type) {
    case "text": return pick(part.body);
    case "button": return pick(part.text);
    case "reaction": return pick(part.emoji);
    case "interactive": {
      const br = part.button_reply as Record<string, unknown> | undefined;
      const lr = part.list_reply as Record<string, unknown> | undefined;
      return pick(br?.title) ?? pick(lr?.title);
    }
    default: return pick(part.caption); // imagen, video, documento con texto
  }
}

/** Convierte el JSON de Meta en lotes por número, ya limpios. null = formato inesperado. */
export function parseWebhook(json: unknown, now = Date.now()): TenantBatch[] | null {
  const parsed = envelope.safeParse(json);
  if (!parsed.success || parsed.data.object !== "whatsapp_business_account") return null;

  const batches = new Map<string, TenantBatch>();
  let items = 0;
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== "messages") continue;
      const phoneId = change.value.metadata?.phone_number_id;
      if (!phoneId || !/^\d{5,30}$/.test(phoneId)) continue;
      const batch = batches.get(phoneId) ?? { phoneNumberId: phoneId, messages: [], statuses: [] };
      batches.set(phoneId, batch);

      const names = new Map<string, string>();
      for (const c of change.value.contacts ?? []) {
        if (c.profile?.name) names.set(c.wa_id, clean(c.profile.name, 200));
      }
      for (const m of change.value.messages ?? []) {
        if (++items > MAX_ITEMS) break;
        if (!/^\d{5,32}$/.test(m.from) || m.id.length > 200) continue;
        const raw = bodyOf(m);
        const img = imageOf(m);
        batch.messages.push({
          waId: m.from,
          name: names.get(m.from) ?? null,
          waMessageId: clean(m.id, 200),
          at: metaDate(m.timestamp, now),
          type: clean(m.type, 30) || "unknown",
          body: raw === null ? null : clean(raw, 4096),
          ...(img ?? {}),
        });
      }
      for (const s of change.value.statuses ?? []) {
        if (++items > MAX_ITEMS) break;
        if (!["sent", "delivered", "read", "failed"].includes(s.status)) continue;
        batch.statuses.push({
          waMessageId: clean(s.id, 200),
          status: s.status as StatusUpdate["status"],
          at: metaDate(s.timestamp, now),
        });
      }
    }
  }
  return [...batches.values()];
}
