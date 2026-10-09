// Utilidad de navegador: POST JSON y devolver { ok, status, data }.
export async function postJson<T = Record<string, unknown>>(
  url: string,
  body: unknown = {},
): Promise<{ ok: boolean; status: number; data: T & { message?: string } }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as T & { message?: string };
    return { ok: res.ok, status: res.status, data };
  } catch {
    return {
      ok: false,
      status: 0,
      data: { message: "No hay conexión con el servidor. Revisa tu internet e intenta de nuevo." } as T & { message?: string },
    };
  }
}
