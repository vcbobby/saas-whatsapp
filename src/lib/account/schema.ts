import { z } from "zod";

/** Sin caracteres de control ni < >: el nombre acaba dentro de mensajes y del texto que lee el asistente. */
export const businessNameSchema = z.object({
  name: z.string().trim().transform((s) => s.replace(/\s+/g, " ")).pipe(
    z.string().min(2, "Mínimo 2 caracteres").max(120, "Máximo 120 caracteres").regex(/^[^\u0000-\u001f\u007f<>]+$/, "Usa solo letras, números y signos normales"),
  ),
});
