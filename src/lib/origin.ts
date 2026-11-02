/** Texto para mostrar de dónde llegó un cliente. Sin dependencias: lo usan pantallas y reportes. */
export type OriginType = "anuncio" | "publicacion";

export function originText(type: OriginType, headline: string | null | undefined): string {
  const base = type === "anuncio" ? "Llegó desde un anuncio" : "Llegó desde una publicación";
  const h = (headline ?? "").trim();
  return h ? `${base}: «${h}»` : base;
}

/** Nombre corto para agrupar en reportes: «Anuncio: Gorras…» / «Publicación». */
export function originLabel(type: OriginType, headline: string | null | undefined): string {
  const h = (headline ?? "").trim();
  const base = type === "anuncio" ? "Anuncio" : "Publicación";
  return h ? `${base}: ${h}` : base;
}
