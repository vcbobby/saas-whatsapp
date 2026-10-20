import { existsSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyState } from "@/components/EmptyState";
import { buildChecklist } from "@/lib/dashboard/pure";
import { HELP_FAQ, HELP_TOPICS, topicForPath } from "@/lib/help";
import { layoutFor } from "@/lib/modules";
import { buildNav } from "@/lib/nav";

const routeExists = (href: string) => existsSync(`src/app/${href.split("#")[0].replace(/^\//, "")}/page.tsx`);

describe("centro de ayuda", () => {
  it("los temas tienen id único, pasos y enlaces a pantallas que existen", () => {
    const ids = HELP_TOPICS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of HELP_TOPICS) {
      expect(t.steps.length).toBeGreaterThan(0);
      expect(t.links.length).toBeGreaterThan(0);
      for (const l of t.links) expect(routeExists(l.href), `${t.id} → ${l.href}`).toBe(true);
    }
    expect(HELP_FAQ.length).toBeGreaterThan(3);
  });

  it("cada pantalla del menú tiene su tema de ayuda", () => {
    const nav = buildNav({ isSuperAdmin: true, hasTenant: true, canManage: true, canPay: true, layout: layoutFor({ type: "citas", hasServices: true, hasProducts: true }) });
    const hrefs = nav.flatMap((g) => g.items.map((i) => i.href)).filter((h) => !["/ayuda", "/admin", "/bienvenida"].includes(h));
    expect(hrefs.length).toBeGreaterThan(8);
    for (const h of hrefs) expect(topicForPath(h), h).not.toBeNull();
    expect(topicForPath("/conversaciones/abc")?.id).toBe("conversaciones");
    expect(topicForPath("/ayuda")).toBeNull();
    expect(nav.flatMap((g) => g.items).some((i) => i.href === "/ayuda")).toBe(true);
  });

  it("el estado vacío muestra título, acciones y enlace a la ayuda", () => {
    const html = renderToStaticMarkup(createElement(EmptyState, { title: "Sin nada", text: "Texto", actions: [{ href: "/catalogo", label: "Ir" }], help: "pedidos" }));
    expect(html).toContain("Sin nada");
    expect(html).toContain('href="/catalogo"');
    expect(html).toContain('href="/ayuda#pedidos"');
  });

  it("«Primeros pasos» lleva al catálogo si vende productos y a la agenda si agenda citas", () => {
    const base = { whatsapp: false, agent: false, kb: false, catalog: false, team: false, message: false };
    expect(buildChecklist({ ...base, sells: true }).find((c) => c.key === "catalogo")?.href).toBe("/catalogo");
    expect(buildChecklist(base).find((c) => c.key === "catalogo")?.href).toBe("/agenda");
  });
});
