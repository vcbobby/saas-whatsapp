import Link from "next/link";
import { brand } from "@/config/brand";
import { headers } from "next/headers";
import { effectiveTenant, getSessionFromHeaders } from "@/lib/auth/session";
import { withTenant } from "@/lib/db";
import { loadModuleLayout, type ModuleLayout, type OptionalModule } from "@/lib/modules";
import { LogoutButton } from "./LogoutButton";

const MODULE_LINK: Record<OptionalModule, { href: string; label: string }> = {
  agenda: { href: "/agenda", label: "Agenda" },
  catalogo: { href: "/catalogo", label: "Catálogo" },
  pedidos: { href: "/pedidos", label: "Pedidos" },
};
const ALL_MAIN: ModuleLayout = { main: ["agenda", "catalogo", "pedidos"], more: [], team: { copiloto: true, automatizaciones: true } };

async function layoutForSession(): Promise<ModuleLayout> {
  // headers() va FUERA del try: es una señal interna de Next y atraparla rompe la renderización.
  const h = await headers();
  try {
    const auth = await getSessionFromHeaders(h);
    const ctx = auth ? effectiveTenant(auth.session) : null;
    if (!ctx) return ALL_MAIN;
    return await withTenant(ctx.tenantId, (db) => loadModuleLayout(db, ctx.tenantId));
  } catch (e) {
    console.error("[menu] no se pudo calcular los módulos; se muestran todos:", e instanceof Error ? e.message : e);
    return ALL_MAIN; // ante cualquier duda se muestra todo: nunca se esconde un módulo por un error
  }
}

export const ROLE_LABEL: Record<string, string> = {
  owner: "Dueño",
  admin: "Administrador",
  agent: "Agente",
};

export async function AppHeader({
  email,
  roleLabel,
  showAdmin,
  showTeam,
  showWork = true,
}: {
  email: string;
  roleLabel?: string;
  showAdmin?: boolean;
  showTeam?: boolean;
  /** Enlaces «Hoy» y «Conversaciones». Se ocultan donde no hay negocio (p. ej. administración). */
  showWork?: boolean;
}) {
  const modules = showWork ? await layoutForSession() : ALL_MAIN;
  return (
    <header className="container-app flex min-h-20 flex-wrap items-center justify-between gap-4 py-4">
      <Link href="/panel" className="text-lg font-medium" style={{ letterSpacing: "-0.01em" }}>
        {brand.name}
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        {showWork && (
          <>
            <Link href="/hoy" className="btn btn-text btn-sm">
              Hoy
            </Link>
            <Link href="/conversaciones" className="btn btn-text btn-sm">
              Conversaciones
            </Link>
            {modules.main.map((m) => (
              <Link key={m} href={MODULE_LINK[m].href} className="btn btn-text btn-sm">
                {MODULE_LINK[m].label}
              </Link>
            ))}
            {modules.more.length > 0 && (
              <details className="relative">
                <summary className="btn btn-text btn-sm cursor-pointer list-none">Más</summary>
                <div className="absolute right-0 z-10 mt-1 flex min-w-[160px] flex-col gap-1 rounded-[16px] p-2" style={{ background: "var(--color-deep-abyss)", border: "1px solid var(--color-field-border)" }}>
                  {modules.more.map((m) => (
                    <Link key={m} href={MODULE_LINK[m].href} className="btn btn-text btn-sm justify-start">
                      {MODULE_LINK[m].label}
                    </Link>
                  ))}
                </div>
              </details>
            )}
          </>
        )}
        {showAdmin && (
          <Link href="/admin" className="btn btn-text btn-sm">
            Administración
          </Link>
        )}
        {showTeam && (
          // Quien puede gestionar el equipo (dueño y administrador) también gestiona el asistente.
          <>
            {modules.team.copiloto && (
              <Link href="/copiloto" className="btn btn-text btn-sm">
              Copiloto
            </Link>
            )}
            <Link href="/agente" className="btn btn-text btn-sm">
              Asistente
            </Link>
            {modules.team.automatizaciones && (
              <Link href="/automatizaciones" className="btn btn-text btn-sm">
              Automatizaciones
            </Link>
            )}
            {modules.team.automatizaciones && (
              <Link href="/conexiones" className="btn btn-text btn-sm">
              Conexiones
            </Link>
            )}
            <Link href="/conocimiento" className="btn btn-text btn-sm">
              Conocimiento
            </Link>
            <Link href="/equipo" className="btn btn-text btn-sm">
              Equipo
            </Link>
          </>
        )}
        <Link href="/seguridad" className="btn btn-text btn-sm">
          Seguridad
        </Link>
        <span className="muted-dark text-sm">{email}</span>
        {roleLabel && <span className="badge badge-neutral">{roleLabel}</span>}
        <LogoutButton />
      </div>
    </header>
  );
}
