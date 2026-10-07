import { getEnv } from "@/lib/env";
import { isWellFormedToken } from "./tokens";

// En local (http) no se puede usar el prefijo __Host-, que exige HTTPS.
function isLocal() {
  return getEnv().APP_ENV === "local";
}

export function sessionCookieName(local: boolean = isLocal()): string {
  return local ? "sid" : "__Host-sid";
}

function attributes(maxAge: number, local: boolean): string {
  // HttpOnly: el JavaScript de la página no puede leerla (frena robo por XSS).
  // SameSite=Lax: no se envía en peticiones POST de otros sitios.
  // Secure + __Host-: solo por HTTPS, sin Domain, válida solo para este host.
  return ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`, ...(local ? [] : ["Secure"])].join("; ");
}

export function buildSessionCookie(
  token: string,
  maxAgeSeconds: number,
  local: boolean = isLocal(),
): string {
  return `${sessionCookieName(local)}=${token}; ${attributes(maxAgeSeconds, local)}`;
}

export function buildClearCookie(local: boolean = isLocal()): string {
  return `${sessionCookieName(local)}=; ${attributes(0, local)}`;
}

export function readSessionToken(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  const name = sessionCookieName();
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() !== name) continue;
    const value = part.slice(i + 1).trim();
    return isWellFormedToken(value) ? value : null;
  }
  return null;
}
