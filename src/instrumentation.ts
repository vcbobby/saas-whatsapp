// Se ejecuta UNA vez al arrancar el servidor. Si la configuración de seguridad está mal, no arranca
// (mejor un error claro al desplegar que un sitio funcionando sin protección).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getSecurityEnv } = await import("@/lib/env");
    getSecurityEnv();
  }
}
