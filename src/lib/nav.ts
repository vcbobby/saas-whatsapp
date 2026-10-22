import type { ModuleLayout, OptionalModule } from "@/lib/modules";

export type NavIcon =
  | "home" | "chat" | "today" | "calendar" | "box" | "receipt" | "bot" | "book" | "flask" | "wand"
  | "phone" | "bolt" | "plug" | "users" | "user" | "help" | "chart" | "pulse" | "mail" | "store" | "tag" | "card" | "shield" | "gear";

export interface NavItem { href: string; label: string; hint: string; icon: NavIcon; /** Solo está activo en esa ruta exacta (no en las de abajo). */ exact?: boolean }
export interface NavGroup { title: string | null; items: NavItem[] }

export interface NavInput {
  /** Hay un negocio activo (si no, solo se muestra Administración). */
  hasTenant: boolean;
  /** Dueño o administrador: gestiona el asistente, el equipo y las integraciones. */
  canManage: boolean;
  /** Solo el dueño (fuera de soporte) puede pagar. */
  canPay: boolean;
  isSuperAdmin: boolean;
  /** Estás dentro de /admin: el menú muestra las secciones de administración. */
  adminMode?: boolean;
  layout: ModuleLayout;
}

const MODULE: Record<OptionalModule, NavItem> = {
  agenda: { href: "/agenda", label: "Agenda", hint: "Citas y horarios", icon: "calendar" },
  catalogo: { href: "/catalogo", label: "Catálogo", hint: "Productos y precios", icon: "box" },
  pedidos: { href: "/pedidos", label: "Pedidos", hint: "Lo que piden tus clientes", icon: "receipt" },
};

/**
 * Menú lateral según quién mira: rol, plan y si es súper admin.
 * Lo que el plan no incluye no aparece (la página tampoco se puede abrir). Los grupos vacíos se quitan.
 */
export const ADMIN_NAV: NavItem[] = [
  { href: "/admin", label: "Resumen", hint: "Registros y estado de los negocios", icon: "chart", exact: true },
  { href: "/admin/negocios", label: "Negocios", hint: "Estados, planes y soporte", icon: "store" },
  { href: "/admin/soporte", label: "Soporte", hint: "Consultas de los negocios", icon: "mail" },
  { href: "/admin/uso", label: "Uso y salud", hint: "Módulos, consumo de IA y errores", icon: "pulse" },
  { href: "/admin/planes", label: "Planes", hint: "Qué incluye cada plan y su precio", icon: "tag" },
  { href: "/admin/cobros", label: "Cobros", hint: "Tasa, métodos de pago y comprobantes", icon: "card" },
];

export function buildNav(i: NavInput): NavGroup[] {
  if (i.adminMode && i.isSuperAdmin) {
    return [
      { title: "Plataforma", items: ADMIN_NAV },
      { title: "Cuenta", items: [
        ...(i.hasTenant ? [{ href: "/panel", label: "Mi negocio", hint: "Volver a tu panel", icon: "home" as const }] : []),
        { href: "/seguridad", label: "Seguridad", hint: "Contraseña y verificación", icon: "shield" as const },
        { href: "/ayuda", label: "Ayuda", hint: "Guías por pantalla y contacto", icon: "help" as const },
      ] },
    ];
  }
  const groups: NavGroup[] = [];
  if (i.hasTenant) {
    groups.push({
      title: null,
      items: [
        { href: "/panel", label: "Inicio", hint: "Resumen de tu negocio", icon: "home" },
        { href: "/hoy", label: "Hoy", hint: "Tareas y avisos por atender", icon: "today" },
        { href: "/conversaciones", label: "Conversaciones", hint: "Chats con tus clientes", icon: "chat" },
      ],
    });
    // Primero los módulos que el negocio usa, luego el resto (todos siguen a un clic).
    const mods = [...i.layout.main, ...i.layout.more];
    if (mods.length) groups.push({ title: "Mi negocio", items: mods.map((m) => MODULE[m]) });
    if (i.canManage) {
      const assistant: NavItem[] = [
        { href: "/agente", label: "Mi asistente", hint: "Cómo atiende y habla", icon: "bot" },
        { href: "/conocimiento", label: "Conocimiento", hint: "Documentos que consulta", icon: "book" },
        { href: "/simulador", label: "Probar", hint: "Chatea con él antes de publicar", icon: "flask" },
      ];
      if (i.layout.team.copiloto) assistant.push({ href: "/copiloto", label: "Copiloto", hint: "Pregúntale por tu negocio", icon: "wand" });
      assistant.push({ href: "/whatsapp", label: "WhatsApp", hint: "Conecta tu número", icon: "phone" });
      groups.push({ title: "Asistente", items: assistant });
      if (i.layout.team.automatizaciones) {
        groups.push({
          title: "Automatizar",
          items: [
            { href: "/automatizaciones", label: "Automatizaciones", hint: "Avisos y reglas automáticas", icon: "bolt" },
            { href: "/conexiones", label: "Conexiones", hint: "Envía datos a otras apps", icon: "plug" },
          ],
        });
      }
    }
  }
  const account: NavItem[] = [];
  if (i.hasTenant) account.push({ href: "/cuenta", label: "Mi cuenta", hint: "Tu negocio y tu perfil", icon: "user" });
  if (i.hasTenant && i.canManage) account.push({ href: "/soporte", label: "Soporte", hint: "Escríbenos y te respondemos", icon: "mail" });
  if (i.hasTenant && i.canManage) account.push({ href: "/equipo", label: "Equipo", hint: "Personas y permisos", icon: "users" });
  if (i.hasTenant && i.canPay) account.push({ href: "/plan", label: "Plan y pagos", hint: "Tu plan y su vencimiento", icon: "card" });
  account.push({ href: "/seguridad", label: "Seguridad", hint: "Contraseña y verificación", icon: "shield" });
  if (i.isSuperAdmin) {
    const admin: NavItem = { href: "/admin", label: "Administración", hint: "Resumen, negocios, planes y cobros", icon: "gear" };
    // Sin negocio, la administración es lo principal: va primero.
    if (i.hasTenant) account.push(admin); else account.unshift(admin);
  }
  account.push({ href: "/ayuda", label: "Ayuda", hint: "Guías por pantalla y contacto", icon: "help" });
  groups.push({ title: i.hasTenant ? "Cuenta" : null, items: account });
  return groups;
}

/** ¿Este ítem es el de la página actual? «/agenda/configuracion» cuenta como «Agenda». */
export function isActive(href: string, pathname: string, exact = false): boolean {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(href + "/");
}
