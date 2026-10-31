import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSession } from "@/lib/auth/session";
import { LEGAL_SLUGS } from "@/lib/legal/docs";
import { loadStore } from "@/lib/storefront/load";
import { securityHeaders } from "@/lib/security/headers";

const isAdminPath = (p: string) => p === "/admin" || p.startsWith("/admin/");

/** /legal/<algo> que no es un documento: debe dar 404 de verdad (la página, al ser dinámica, respondería 200 con un aviso). */
const isUnknownLegalDoc = (p: string) => {
  const m = /^\/legal\/([^/]+)\/?$/.exec(p);
  if (!m) return false;
  try {
    return !(LEGAL_SLUGS as readonly string[]).includes(decodeURIComponent(m[1]!));
  } catch {
    return true; // mal codificada: tampoco es un documento
  }
};

/** /c/<slug> sin catálogo publicado: 404 de verdad (si la base falla, se deja pasar y la página decide). */
async function isUnknownStore(p: string): Promise<boolean> {
  const m = /^\/c\/([^/]+)\/?$/.exec(p);
  if (!m) return false;
  try {
    return (await loadStore(decodeURIComponent(m[1]!))) === null;
  } catch {
    return false;
  }
}

/**
 * Páginas de administración: para quien no sea súper admin deben responder 404 REAL (estado HTTP incluido),
 * igual que cualquier dirección inexistente. Con prerenderizado parcial, el `notFound()` de la página llega
 * tarde (el 200 ya se envió), por eso se decide aquí. Pasa un súper admin, o quien está por activar su 2FA
 * (la página lo manda a /seguridad). Si algo falla al comprobar, se responde 404 (cierra por defecto).
 */
async function mayEnterAdmin(request: NextRequest): Promise<boolean> {
  try {
    const s = await getSession(request);
    return !!s && (s.isSuperAdmin || s.needsMfaSetup);
  } catch (err) {
    console.error("[proxy] no se pudo comprobar la sesión de /admin:", err instanceof Error ? err.message : err);
    return false;
  }
}

// Se lee en cada petición (no al compilar), así APP_ENV de tu servidor decide si hay HSTS, etc.
export async function proxy(request: NextRequest) {
  const response =
    (isAdminPath(request.nextUrl.pathname) && !(await mayEnterAdmin(request))) || isUnknownLegalDoc(request.nextUrl.pathname) || (await isUnknownStore(request.nextUrl.pathname))
      ? NextResponse.rewrite(new URL("/no-existe", request.url)) // una dirección que no existe: Next responde su 404
      : NextResponse.next();
  const headers = securityHeaders({
    appEnv: process.env.APP_ENV,
    dev: process.env.NODE_ENV === "development",
    embeddedSignup: process.env.EMBEDDED_SIGNUP_ENABLED === "true",
  });
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

export const config = {
  // Todo menos los archivos estáticos de Next (no son documentos y no necesitan estas cabeceras).
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
