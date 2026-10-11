import type { ZodType } from "zod";
import { getEnv } from "@/lib/env";

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

export function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>) {
  return Response.json(body, { status, headers: { ...BASE_HEADERS, ...headers } });
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  extra?: { fields?: string[]; headers?: Record<string, string> },
) {
  return jsonResponse({ error: code, message, fields: extra?.fields }, status, extra?.headers);
}

/**
 * Defensa contra CSRF para peticiones que cambian cosas.
 * Acepta solo si el navegador dice que viene de NUESTRO sitio.
 */
export function checkOrigin(req: Request): Response | null {
  const expected = new URL(getEnv().APP_URL).origin;
  const origin = req.headers.get("origin");
  if (origin) {
    return origin === expected
      ? null
      : errorResponse(403, "origen_no_permitido", "Petición no permitida.");
  }
  if (req.headers.get("sec-fetch-site") === "same-origin") return null;
  return errorResponse(403, "origen_no_permitido", "Petición no permitida.");
}

const MAX_BODY_BYTES = 10_000;

export async function readJson<T>(
  req: Request,
  schema: ZodType<T>,
  opts: { maxChars?: number } = {},
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("application/json")) {
    return {
      ok: false,
      response: errorResponse(415, "tipo_no_soportado", "Se esperaba application/json."),
    };
  }
  const text = await req.text();
  if (text.length > (opts.maxChars ?? MAX_BODY_BYTES)) {
    return { ok: false, response: errorResponse(413, "cuerpo_muy_grande", "Petición demasiado grande.") };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, response: errorResponse(400, "json_invalido", "JSON inválido.") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(cuerpo)"))];
    const message = parsed.error.issues[0]?.message ?? "Datos inválidos.";
    return {
      ok: false,
      response: errorResponse(400, "datos_invalidos", message, { fields }),
    };
  }
  return { ok: true, data: parsed.data };
}

/** Envuelve una ruta: errores inesperados -> 500 genérico, sin filtrar detalles. */
export function route(handler: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    try {
      return await handler(req);
    } catch (err) {
      const e = err as { code?: string; message?: string; digest?: string };
      // Señales internas de Next.js (por ejemplo "esta ruta es dinámica"): no se tocan.
      if (typeof e.digest === "string") throw err;
      if (e.code === "42501" || e.code === "no_data_found" || e.code === "P0002") {
        return errorResponse(404, "no_encontrado", "No encontrado.");
      }
      if (e.code === "22023") {
        return errorResponse(400, "datos_invalidos", "Datos inválidos.");
      }
      console.error("[api] error inesperado:", e.code ?? "", e.message ?? "");
      return errorResponse(500, "error_interno", "Ocurrió un error. Intenta de nuevo.");
    }
  };
}
