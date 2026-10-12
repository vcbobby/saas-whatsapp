export const WEEKDAYS = [
  { n: 1, label: "Lunes" },
  { n: 2, label: "Martes" },
  { n: 3, label: "Miércoles" },
  { n: 4, label: "Jueves" },
  { n: 5, label: "Viernes" },
  { n: 6, label: "Sábado" },
  { n: 7, label: "Domingo" },
] as const;

/** Zonas más comunes entre hispanohablantes. (La API acepta cualquier nombre IANA válido.) */
export const COMMON_TIMEZONES: { id: string; label: string }[] = [
  { id: "America/Caracas", label: "Venezuela (Caracas)" },
  { id: "America/Bogota", label: "Colombia (Bogotá)" },
  { id: "America/Mexico_City", label: "México (Ciudad de México)" },
  { id: "America/Argentina/Buenos_Aires", label: "Argentina (Buenos Aires)" },
  { id: "America/Santiago", label: "Chile (Santiago)" },
  { id: "America/Lima", label: "Perú (Lima)" },
  { id: "America/Guayaquil", label: "Ecuador (Guayaquil)" },
  { id: "America/La_Paz", label: "Bolivia (La Paz)" },
  { id: "America/Montevideo", label: "Uruguay (Montevideo)" },
  { id: "America/Asuncion", label: "Paraguay (Asunción)" },
  { id: "America/Panama", label: "Panamá" },
  { id: "America/Costa_Rica", label: "Costa Rica" },
  { id: "America/Guatemala", label: "Guatemala" },
  { id: "America/Santo_Domingo", label: "República Dominicana" },
  { id: "America/Puerto_Rico", label: "Puerto Rico" },
  { id: "America/New_York", label: "EE. UU. Este (Nueva York)" },
  { id: "America/Chicago", label: "EE. UU. Centro (Chicago)" },
  { id: "America/Denver", label: "EE. UU. Montaña (Denver)" },
  { id: "America/Los_Angeles", label: "EE. UU. Pacífico (Los Ángeles)" },
  { id: "Europe/Madrid", label: "España (Madrid)" },
];

export const STEP_OPTIONS = [5, 10, 15, 20, 30, 45, 60] as const;
export const NOTICE_OPTIONS: { minutes: number; label: string }[] = [
  { minutes: 0, label: "Sin preaviso" },
  { minutes: 30, label: "30 minutos" },
  { minutes: 60, label: "1 hora" },
  { minutes: 120, label: "2 horas" },
  { minutes: 240, label: "4 horas" },
  { minutes: 720, label: "12 horas" },
  { minutes: 1440, label: "1 día" },
  { minutes: 2880, label: "2 días" },
];
