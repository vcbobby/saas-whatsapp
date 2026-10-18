import { errorResponse } from "@/lib/auth/http";

/** Errores de las funciones de cobro -> respuestas claras. null = no es de cobro. */
export function billingErrorResponse(err: unknown): Response | null {
  const e = err as { code?: string };
  switch (e.code) {
    case "42501": return errorResponse(403, "sin_permiso", "Solo el dueño del negocio puede pagar o cambiar de plan.");
    case "P0002": return errorResponse(404, "no_encontrado", "No encontrado, o el plan no está disponible.");
    case "22023": return errorResponse(400, "datos_invalidos", "Revisa los datos: referencia, fecha (de los últimos 3 días), monto y la imagen del comprobante.");
    case "54000": return errorResponse(409, "demasiados_pagos", "Ya tienes 3 pagos abiertos. Termina o espera a que venzan antes de crear otro.");
    case "0A000": return errorResponse(409, "metodo_no_disponible", "Ese método de pago no está disponible por ahora. Elige otro o escríbenos.");
    case "55000": return errorResponse(409, "estado_invalido", "Ese pago ya no está en un estado que lo permita (quizá ya se envió o se resolvió).");
    case "23505": return errorResponse(409, "referencia_repetida", "Esa referencia ya fue usada en otro pago.");
    default: return null;
  }
}
/** Mensaje específico cuando la tasa no está al día (misma code 55000 que «estado inválido», se distingue por texto). */
export function isStaleRate(err: unknown): boolean {
  return /tasa desactualizada/.test((err as { message?: string }).message ?? "");
}
