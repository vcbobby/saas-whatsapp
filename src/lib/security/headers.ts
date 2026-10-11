/**
 * Cabeceras de seguridad de todas las respuestas (las aplica src/proxy.ts).
 *
 * CSP SIN nonces, a propósito: los nonces obligan a que TODAS las páginas se generen en cada visita
 * y son incompatibles con `cacheComponents` / prerenderizado parcial, que usamos. Se mantiene
 * 'unsafe-inline' en scripts (los pequeños scripts de arranque que Next mete en cada página) y se cierra
 * todo lo demás: nada de scripts, estilos o conexiones de otros sitios, ni frames, ni <object>,
 * ni que nos incrusten, ni formularios que envíen a otro dominio.
 */
export interface HeaderOptions {
  appEnv: string | undefined;
  /** NODE_ENV === "development": hace falta 'unsafe-eval' y WebSockets para la recarga en vivo. */
  dev: boolean;
}

export function buildCsp({ appEnv, dev }: HeaderOptions): string {
  const hosted = appEnv === "production" || appEnv === "staging";
  const directives: string[] = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    // data: lo usa el código QR de la verificación en 2 pasos.
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "manifest-src 'self'",
  ];
  if (hosted) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

export function securityHeaders(opts: HeaderOptions): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Security-Policy": buildCsp(opts),
    "X-Content-Type-Options": "nosniff",
    // Las invitaciones llevan el código en la dirección: ningún sitio externo debe recibirla como "referencia".
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Permitted-Cross-Domain-Policies": "none",
  };
  // HSTS solo en servidores reales (en tu computadora usas http y no debe aplicarse).
  if (opts.appEnv === "production") h["Strict-Transport-Security"] = "max-age=31536000";
  else if (opts.appEnv === "staging") h["Strict-Transport-Security"] = "max-age=86400";
  return h;
}
