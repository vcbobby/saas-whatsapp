import { describe, expect, it } from "vitest";
import { buildNav, isActive, type NavInput } from "@/lib/nav";
import { layoutFor } from "@/lib/modules";

const base: NavInput = { hasTenant: true, canManage: true, canPay: true, isSuperAdmin: false, layout: layoutFor({ type: "citas", hasServices: true, hasProducts: false }) };
const hrefs = (i: Partial<NavInput>) => buildNav({ ...base, ...i }).flatMap((g) => g.items.map((x) => x.href));
const titles = (i: Partial<NavInput>) => buildNav({ ...base, ...i }).map((g) => g.title);

describe("menú lateral", () => {
  it("el dueño ve todo, en grupos con nombre", () => {
    expect(titles({})).toEqual([null, "Mi negocio", "Asistente", "Automatizar", "Cuenta"]);
    expect(hrefs({})).toEqual(["/panel", "/hoy", "/conversaciones", "/agenda", "/catalogo", "/pedidos", "/agente", "/conocimiento", "/simulador", "/copiloto", "/whatsapp", "/automatizaciones", "/conexiones", "/cuenta", "/equipo", "/plan", "/seguridad"]);
  });
  it("los módulos que el negocio usa van primero; los demás siguen a un clic", () => {
    const h = hrefs({ layout: layoutFor({ type: "catalogo", hasServices: false, hasProducts: true }) });
    expect(h.slice(3, 6)).toEqual(["/catalogo", "/pedidos", "/agenda"]);
  });
  it("lo que el plan no incluye no aparece", () => {
    const l = layoutFor({ type: "citas", hasServices: true, hasProducts: true, allowed: ["agenda"] });
    const h = hrefs({ layout: l });
    expect(h).toContain("/agenda");
    for (const x of ["/catalogo", "/pedidos", "/copiloto", "/automatizaciones", "/conexiones"]) expect(h).not.toContain(x);
    expect(titles({ layout: l })).not.toContain("Automatizar");
  });
  it("un agente solo ve su trabajo del día, su cuenta y su seguridad", () => {
    expect(hrefs({ canManage: false, canPay: false })).toEqual(["/panel", "/hoy", "/conversaciones", "/agenda", "/catalogo", "/pedidos", "/cuenta", "/seguridad"]);
  });
  it("solo el dueño ve «Plan y pagos»; un administrador no", () => {
    expect(hrefs({ canPay: true })).toContain("/plan");
    expect(hrefs({ canPay: false })).not.toContain("/plan");
    expect(hrefs({ canPay: false })).toContain("/equipo");
  });
  it("el súper admin ve «Administración»; sin negocio, solo cuenta y administración", () => {
    expect(hrefs({ isSuperAdmin: true })).toContain("/admin");
    expect(hrefs({ isSuperAdmin: false })).not.toContain("/admin");
    expect(hrefs({ hasTenant: false, canManage: false, canPay: false, isSuperAdmin: true })).toEqual(["/admin", "/seguridad"]);
    expect(titles({ hasTenant: false, canManage: false, canPay: false, isSuperAdmin: true })).toEqual([null]);
  });
  it("sin negocio no aparecen Equipo ni Plan y pagos, aunque los permisos digan que sí", () => {
    const h = hrefs({ hasTenant: false, canManage: true, canPay: true });
    expect(h).toEqual(["/seguridad"]);
    expect(h).not.toContain("/cuenta");
  });
  it("si el plan no incluye ningún módulo, no hay grupo «Mi negocio» vacío", () => {
    const l = layoutFor({ type: "citas", hasServices: true, hasProducts: true, allowed: [] });
    expect(titles({ layout: l })).not.toContain("Mi negocio");
  });
  it("cada ítem tiene nombre y una línea que explica para qué sirve; no hay enlaces repetidos", () => {
    const items = buildNav({ ...base, isSuperAdmin: true }).flatMap((g) => g.items);
    expect(new Set(items.map((x) => x.href)).size).toBe(items.length);
    for (const x of items) { expect(x.label.length).toBeGreaterThan(2); expect(x.hint.length).toBeGreaterThan(8); expect(x.href.startsWith("/")).toBe(true); }
  });
  it("marca la página actual, también en subpáginas, sin confundir prefijos parecidos", () => {
    expect(isActive("/agenda", "/agenda")).toBe(true);
    expect(isActive("/agenda", "/agenda/configuracion")).toBe(true);
    expect(isActive("/agenda", "/agendar")).toBe(false);
    expect(isActive("/panel", "/hoy")).toBe(false);
    expect(isActive("/hoy", "/")).toBe(false);
  });
});
