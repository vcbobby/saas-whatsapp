import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getSessionFromHeaders } from "@/lib/auth/session";

/** Comprobación común de las páginas de /admin (el proxy ya responde 404 a quien no es súper admin; aquí se repite). */
export async function requireAdminPage() {
  const auth = await getSessionFromHeaders(await headers());
  if (!auth) notFound();
  if (auth.session.needsMfaSetup) redirect("/seguridad");
  if (!auth.session.isSuperAdmin) notFound();
  return auth;
}
