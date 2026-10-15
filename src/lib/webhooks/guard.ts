import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { devToolsEnabled } from "@/lib/env";

/**
 * Protección contra SSRF: un negocio escribe la dirección de destino, así que NUNCA se debe poder apuntar a la red interna
 * del servidor (base de datos, Redis, metadatos de la nube, etc.). Se bloquean direcciones privadas, locales y reservadas,
 * y se valida la dirección REAL a la que se conectará el envío (no solo el nombre).
 */
const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32], ["64:ff9b::", 96], ["100::", 64], ["2002::", 16], ["2001::", 32],
] as const) blocked.addSubnet(net, bits, "ipv6");

/** ¿Es una dirección IP pública (alcanzable en Internet y no reservada)? Las IPv4 «mapeadas» en IPv6 se revisan como IPv4. */
export function isPublicIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 0) return false;
  const mapped = kind === 6 ? /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip) : null;
  if (mapped) return isPublicIp(mapped[1]!);
  const hexMapped = kind === 6 ? /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip) : null;
  if (hexMapped) {
    const hi = parseInt(hexMapped[1]!, 16), lo = parseInt(hexMapped[2]!, 16);
    return isPublicIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return !blocked.check(ip, kind === 4 ? "ipv4" : "ipv6");
}

/** Solo en computadoras de desarrollo y pruebas (nunca en staging ni producción, aunque la variable esté puesta). */
export function allowPrivateTargets(): boolean {
  return devToolsEnabled() && process.env.WEBHOOKS_ALLOW_PRIVATE_TARGETS === "true";
}

export interface Target { url: URL; address: string; family: 4 | 6 }
export type TargetCheck = { ok: true; target: Target } | { ok: false; reason: string };

const BAD_SUFFIX = /\.(local|localhost|internal|intranet|lan|home|corp|localdomain)$/i;

/** Valida la dirección escrita por el negocio y resuelve a qué IP pública se conectará. */
export async function resolveTarget(raw: string, opts: { allowPrivate?: boolean; resolver?: (host: string) => Promise<{ address: string; family: number }[]> } = {}): Promise<TargetCheck> {
  const allowPrivate = opts.allowPrivate ?? allowPrivateTargets();
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return { ok: false, reason: "La dirección no es válida. Debe verse así: https://tu-sistema.com/aviso" }; }
  if (raw.length > 2000) return { ok: false, reason: "La dirección es demasiado larga." };
  if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:")) return { ok: false, reason: "La dirección debe empezar con https://" };
  if (url.username || url.password) return { ok: false, reason: "La dirección no puede incluir usuario ni contraseña." };
  if (url.hash) return { ok: false, reason: "La dirección no puede llevar «#»." };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) return { ok: false, reason: "Falta el dominio de la dirección." };
  if (!allowPrivate && (host.toLowerCase() === "localhost" || BAD_SUFFIX.test(host) || !host.includes(".") && isIP(host) === 0)) {
    return { ok: false, reason: "Esa dirección apunta a una red interna. Usa el dominio público de tu sistema." };
  }
  let addrs: { address: string; family: number }[];
  if (isIP(host)) addrs = [{ address: host, family: isIP(host) }];
  else {
    try { addrs = await (opts.resolver ?? ((h) => lookup(h, { all: true, verbatim: true })))(host); } catch { return { ok: false, reason: "No se pudo encontrar ese dominio. Revisa que esté bien escrito y publicado." }; }
  }
  if (addrs.length === 0) return { ok: false, reason: "No se pudo encontrar ese dominio." };
  // TODAS las direcciones deben ser públicas: así un dominio con una IP interna escondida entre las públicas tampoco pasa.
  if (!allowPrivate && addrs.some((a) => !isPublicIp(a.address))) return { ok: false, reason: "Esa dirección apunta a una red interna. Usa el dominio público de tu sistema." };
  const first = addrs[0]!;
  return { ok: true, target: { url, address: first.address, family: first.family === 6 ? 6 : 4 } };
}
