import { z } from "zod";
import { getPool } from "@/lib/db";
import { getConsentMode } from "@/lib/env";
import { LEGAL_VERSION } from "./docs";

/** Campo que envían los formularios de registro: la casilla «Acepto los términos y la política de privacidad». */
export const acceptTermsField = z.literal(true).optional();

/**
 * Versión que se registra al crear una cuenta. En modo «required» hay que haber marcado la casilla (acceptTerms: true);
 * en modo «optional» (solo pruebas automáticas) se registra solo si la marcaron.
 * Devuelve la versión a guardar, null (no guardar nada) o "missing" (falta aceptar).
 */
export function consentVersionFor(accepted: boolean | undefined): string | null | "missing" {
  if (accepted === true) return LEGAL_VERSION;
  return getConsentMode() === "required" ? "missing" : null;
}

export const CONSENT_REQUIRED_MESSAGE = "Para continuar debes aceptar los términos y la política de privacidad.";

export interface LegalStatus {
  current: string;
  accepted: string | null;
  acceptedAt: string | null;
  upToDate: boolean;
}

export async function getLegalStatus(userId: string): Promise<LegalStatus> {
  const r = await getPool().query<{ version: string; accepted_at: Date }>("SELECT * FROM legal_latest($1)", [userId]);
  const row = r.rows[0];
  return { current: LEGAL_VERSION, accepted: row?.version ?? null, acceptedAt: row ? row.accepted_at.toISOString() : null, upToDate: row?.version === LEGAL_VERSION };
}

export async function recordAcceptance(userId: string, version: string, context: "signup" | "invitation" | "reaccept"): Promise<void> {
  await getPool().query("SELECT legal_accept($1, $2, $3)", [userId, version, context]);
}
