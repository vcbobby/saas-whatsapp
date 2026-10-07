// Único lugar donde viven el nombre y los datos de marca.
// Al decidir el nombre definitivo, solo se cambia aquí o en las variables de entorno.
export const brand = {
  name: process.env.NEXT_PUBLIC_APP_NAME ?? "Plataforma",
  domain: process.env.NEXT_PUBLIC_APP_DOMAIN ?? "localhost:3000",
  supportEmail: process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "soporte@example.com",
  legalName: process.env.NEXT_PUBLIC_LEGAL_NAME ?? "Por definir",
} as const;
