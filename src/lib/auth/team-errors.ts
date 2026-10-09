import { errorResponse } from "./http";

/** Errores de las funciones de equipo -> respuestas HTTP claras. null = no es de equipo. */
export function teamErrorResponse(err: unknown): Response | null {
  const e = err as { code?: string };
  if (e.code === "23505") return errorResponse(409, "ya_es_miembro", "Esa persona ya forma parte del equipo.");
  if (e.code === "54000") return errorResponse(409, "limite_equipo", "Llegaste al máximo de personas del equipo.");
  if (e.code === "22023") return errorResponse(400, "datos_invalidos", "Datos inválidos.");
  if (e.code === "42501") return errorResponse(403, "sin_permiso", "No tienes permiso para esto.");
  if (e.code === "P0002") return errorResponse(404, "no_encontrado", "No encontrado.");
  return null;
}
