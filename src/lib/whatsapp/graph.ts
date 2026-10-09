import { getWhatsAppEnv } from "@/lib/env";

export interface PhoneInfo {
  displayPhoneNumber: string;
  verifiedName: string | null;
}

/**
 * Comprueba con Meta que el token realmente controla ese número.
 * Evita que alguien "reserve" el número de otro negocio solo conociendo su id.
 * `fetchImpl` se puede cambiar en los tests.
 */
export async function fetchPhoneInfo(
  phoneNumberId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PhoneInfo | null> {
  if (!/^\d{5,30}$/.test(phoneNumberId)) return null;
  const { WHATSAPP_GRAPH_VERSION } = getWhatsAppEnv();
  const url = `https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${phoneNumberId}?fields=display_phone_number,verified_name`;
  try {
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8_000),
      redirect: "error",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { id?: string; display_phone_number?: string; verified_name?: string };
    if (data.id !== undefined && data.id !== phoneNumberId) return null;
    if (!data.display_phone_number) return null;
    return {
      displayPhoneNumber: String(data.display_phone_number).slice(0, 40),
      verifiedName: data.verified_name ? String(data.verified_name).slice(0, 200) : null,
    };
  } catch {
    return null;
  }
}
