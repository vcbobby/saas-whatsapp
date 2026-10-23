// Único lugar donde vive el nombre de la app. Cambiarlo aquí (o en .env.local)
// lo cambia en todas las pantallas.
export const brand = {
  name: process.env.NEXT_PUBLIC_APP_NAME ?? "Plataforma",
  domain: process.env.NEXT_PUBLIC_APP_DOMAIN ?? "localhost",
  supportEmail: process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "soporte@example.com",
  legalName: process.env.NEXT_PUBLIC_LEGAL_NAME ?? "",
  // Datos para los documentos legales. Lo que quede vacío aparece marcado como [PENDIENTE] en los documentos.
  legalAddress: process.env.NEXT_PUBLIC_LEGAL_ADDRESS ?? "",
  legalCountry: process.env.NEXT_PUBLIC_LEGAL_COUNTRY ?? "",
  // «1» solo cuando un abogado revisó los documentos. Mientras no, se muestran como BORRADOR.
  legalReviewed: process.env.NEXT_PUBLIC_LEGAL_REVIEWED === "1",
} as const;
