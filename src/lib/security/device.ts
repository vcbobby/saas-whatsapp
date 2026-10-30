import { createHash } from "node:crypto";

export interface Device { label: string; hash: string }

/**
 * «Chrome en Windows»: navegador + sistema, sin versiones (así una actualización del navegador no cuenta como dispositivo nuevo)
 * y sin guardar el texto completo del navegador. La huella es un hash de esa etiqueta.
 */
export function describeDevice(userAgent: string | null | undefined): Device {
  const ua = (userAgent ?? "").slice(0, 400);
  const browser =
    /Edg(?:e|A|iOS)?\//.test(ua) ? "Edge"
    : /OPR\/|Opera/.test(ua) ? "Opera"
    : /SamsungBrowser\//.test(ua) ? "Samsung Internet"
    : /Firefox\/|FxiOS\//.test(ua) ? "Firefox"
    : /Chrome\/|CriOS\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : /curl\/|python|node|axios|Go-http|okhttp|Postman/i.test(ua) ? "Programa o script"
    : "Navegador desconocido";
  const os =
    /Windows/.test(ua) ? "Windows"
    : /Android/.test(ua) ? "Android"
    : /iPhone|iPad|iPod/.test(ua) ? "iOS"
    : /Mac OS X|Macintosh/.test(ua) ? "macOS"
    : /CrOS/.test(ua) ? "ChromeOS"
    : /Linux|X11/.test(ua) ? "Linux"
    : "sistema desconocido";
  const label = `${browser} en ${os}`;
  return { label, hash: createHash("sha256").update(label).digest("hex").slice(0, 32) };
}
