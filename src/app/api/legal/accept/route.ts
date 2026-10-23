import { z } from "zod";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { requireSession } from "@/lib/auth/guard";
import { recordAcceptance } from "@/lib/legal/consent";
import { LEGAL_VERSION } from "@/lib/legal/docs";

const schema = z.object({ version: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[a-z0-9]{1,20})?$/) });

/** Aceptar la versión vigente de los documentos legales (cuando cambian, quien ya tiene cuenta debe volver a aceptar). */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  // Solo se registra la versión vigente: si la persona vio una versión vieja, debe recargar y leer la nueva.
  if (body.data.version !== LEGAL_VERSION) return errorResponse(409, "version_desactualizada", "Los documentos cambiaron mientras tenías la pantalla abierta. Recarga la página y léelos de nuevo.");
  await recordAcceptance(auth.session.userId, LEGAL_VERSION, "reaccept");
  return jsonResponse({ ok: true, version: LEGAL_VERSION });
}, { limit: "api" });
