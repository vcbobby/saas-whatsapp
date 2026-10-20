import { brand } from "@/config/brand";
import { headers } from "next/headers";
import { can } from "@/lib/auth/permissions";
import { effectiveTenant, getSessionFromHeaders } from "@/lib/auth/session";
import { withTenant } from "@/lib/db";
import { loadModuleLayout, type ModuleLayout } from "@/lib/modules";
import { buildNav } from "@/lib/nav";
import { LogoutButton } from "./LogoutButton";
import { Sidebar } from "./Sidebar";

const ALL_MAIN: ModuleLayout = { main: ["agenda", "catalogo", "pedidos"], more: [], team: { copiloto: true, automatizaciones: true } };

async function layoutForSession(): Promise<{ layout: ModuleLayout; canPay: boolean; hasTenant: boolean }> {
  // headers() va FUERA del try: es una señal interna de Next y atraparla rompe la renderización.
  const h = await headers();
  try {
    const auth = await getSessionFromHeaders(h);
    const ctx = auth ? effectiveTenant(auth.session) : null;
    if (!ctx) return { layout: ALL_MAIN, canPay: false, hasTenant: false };
    const layout = await withTenant(ctx.tenantId, (db) => loadModuleLayout(db, ctx.tenantId));
    return { layout, canPay: can(ctx.role, "billing:manage") && !ctx.impersonating, hasTenant: true };
  } catch (e) {
    console.error("[menu] no se pudo calcular los módulos; se muestran todos:", e instanceof Error ? e.message : e);
    return { layout: ALL_MAIN, canPay: false, hasTenant: true }; // ante cualquier duda se muestra todo: nunca se esconde un módulo por un error
  }
}

export const ROLE_LABEL: Record<string, string> = {
  owner: "Dueño",
  admin: "Administrador",
  agent: "Agente",
};

/** Menú lateral de la app (en celular, barra superior con cajón). Las páginas lo usan igual que antes. */
export async function AppHeader({
  email,
  roleLabel,
  showAdmin,
  showTeam,
  showWork = true,
  adminMode = false,
}: {
  email: string;
  roleLabel?: string;
  showAdmin?: boolean;
  showTeam?: boolean;
  /** Hay un negocio detrás de esta pantalla. Se oculta en administración. */
  showWork?: boolean;
  /** Dentro de /admin: menú de administración. */
  adminMode?: boolean;
}) {
  const { layout, canPay, hasTenant } = showWork ? await layoutForSession() : { layout: ALL_MAIN, canPay: false, hasTenant: false };
  const groups = buildNav({ hasTenant, canManage: !!showTeam, canPay, isSuperAdmin: !!showAdmin, layout, adminMode });
  return (
    <Sidebar
      brandName={brand.name}
      groups={groups}
      footer={
        <>
          <p className="app-user" title={email}>{email}</p>
          <div className="app-footer-row">
            {roleLabel && <span className="badge badge-neutral">{roleLabel}</span>}
            <LogoutButton />
          </div>
        </>
      }
    />
  );
}
