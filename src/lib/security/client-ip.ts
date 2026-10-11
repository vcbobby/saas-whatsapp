import { isIP } from "node:net";
import { getSecurityEnv } from "@/lib/env";

/** Cuando no se puede saber la IP real. Todas esas peticiones comparten un cupo (más amplio, ver rate-limit). */
export const UNKNOWN_IP = "unknown";

/**
 * Expande una IPv6 a sus 8 bloques. Devuelve null si no es válida.
 * Si es una IPv4 "disfrazada" (::ffff:1.2.3.4) devuelve la IPv4.
 */
function normalizeV6(ip: string): string | null {
  const lower = ip.toLowerCase().split("%")[0]!; // sin zona (fe80::1%eth0)
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (mapped && isIP(mapped[1]!) === 4) return mapped[1]!;
  let head = lower;
  // IPv4 al final (64:ff9b::1.2.3.4): se convierte a dos bloques hexadecimales.
  const v4tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(head);
  if (v4tail) {
    const n = v4tail.slice(1, 5).map(Number);
    if (n.some((x) => x > 255)) return null;
    head = head.slice(0, v4tail.index) + ((n[0]! << 8) | n[1]!).toString(16) + ":" + ((n[2]! << 8) | n[3]!).toString(16);
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...right];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.padStart(4, "0")).join(":");
}

/**
 * Deja la IP lista para usarla como clave de límite.
 * IPv4: tal cual. IPv6: solo el prefijo /64, porque quien tiene una IPv6 casi siempre controla todo su /64
 * (si no, rotaría de dirección en cada petición y el límite no serviría de nada).
 */
export function normalizeIp(raw: string): string | null {
  const ip = raw.trim();
  const kind = isIP(ip);
  if (kind === 4) return ip;
  if (kind !== 6) return null;
  const full = normalizeV6(ip);
  if (!full) return null;
  if (isIP(full) === 4) return full; // IPv4 disfrazada
  return full.split(":").slice(0, 4).join(":") + "::/64";
}

/**
 * IP del visitante. Las cabeceras de IP las puede escribir cualquiera, así que SOLO se leen
 * según TRUSTED_PROXY, que dice quién está delante de la aplicación:
 *  - "none":       nadie de confianza → no se lee ninguna cabecera (IP desconocida).
 *  - "cloudflare": se usa CF-Connecting-IP (la aplicación solo debe ser alcanzable a través de Cloudflare / el túnel).
 *  - "proxy":      un único proxy tuyo (nginx, Caddy…) que AÑADE la IP al final de X-Forwarded-For.
 */
export function clientIp(req: Request, mode: "none" | "cloudflare" | "proxy" = getSecurityEnv().trustedProxy): string {
  let raw: string | null = null;
  if (mode === "cloudflare") {
    raw = req.headers.get("cf-connecting-ip");
  } else if (mode === "proxy") {
    const parts = (req.headers.get("x-forwarded-for") ?? "").split(",");
    raw = parts[parts.length - 1] ?? null;
  }
  if (!raw) return UNKNOWN_IP;
  return normalizeIp(raw) ?? UNKNOWN_IP;
}
