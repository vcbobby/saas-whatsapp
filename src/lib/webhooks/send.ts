import http from "node:http";
import https from "node:https";
import type { Target } from "./guard";

export interface SendResult { ok: boolean; status: number | null; error: string | null }

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 16_384;

/**
 * POST con cuerpo JSON a una dirección ya validada. Reglas de seguridad:
 *  - Se conecta a la IP que validamos (no se vuelve a resolver el nombre: evita el cambio de DNS entre la revisión y el envío).
 *  - No sigue redirecciones (una respuesta 3xx cuenta como fallo).
 *  - Tiempo máximo de 10 s en total y la respuesta se lee solo hasta 16 KB.
 *  - Los mensajes de error no incluyen direcciones internas ni contenido de la respuesta.
 */
export function sendWebhook(target: Target, headers: Record<string, string>, body: string, timeoutMs = TIMEOUT_MS): Promise<SendResult> {
  return new Promise((resolve) => {
    const { url } = target;
    const lib = url.protocol === "https:" ? https : http;
    let done = false;
    const finish = (r: SendResult) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const req = lib.request(
      {
        method: "POST",
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
        agent: false,
        // Conectar siempre a la IP validada.
        lookup: (_h, opts, cb) => {
          const o = opts as { all?: boolean };
          if (o.all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: target.address, family: target.family }]);
          else cb(null, target.address, target.family);
        },
      },
      (res) => {
        let bytes = 0;
        res.on("data", (c: Buffer) => { bytes += c.length; if (bytes > MAX_RESPONSE_BYTES) res.destroy(); });
        const status = res.statusCode ?? 0;
        const end = () => finish(status >= 200 && status < 300 ? { ok: true, status, error: null } : { ok: false, status, error: status >= 300 && status < 400 ? "El destino respondió con una redirección (no se siguen)" : `El destino respondió ${status}` });
        res.on("end", end);
        res.on("close", end);
        res.on("error", end);
      },
    );
    const timer = setTimeout(() => { req.destroy(); finish({ ok: false, status: null, error: "El destino no respondió a tiempo (10 s)" }); }, timeoutMs);
    req.on("error", (e: NodeJS.ErrnoException) => {
      const code = e.code ?? "";
      const msg = code === "ECONNREFUSED" ? "El destino rechazó la conexión" : code === "ENOTFOUND" ? "No se encontró el dominio" : code.startsWith("ERR_TLS") || code.includes("CERT") || code === "DEPTH_ZERO_SELF_SIGNED_CERT" ? "El certificado HTTPS del destino no es válido" : code === "ECONNRESET" ? "La conexión se cortó" : "No se pudo conectar con el destino";
      finish({ ok: false, status: null, error: msg });
    });
    req.end(body);
  });
}
