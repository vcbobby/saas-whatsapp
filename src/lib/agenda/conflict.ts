/**
 * ¿El error de la base significa «ese horario ya lo ocupa otra cita»?
 *  - 23P01: la restricción de exclusión rechazó la cita porque se solapa con otra.
 *  - 40P01: bloqueo mutuo (deadlock) entre dos reservas simultáneas que se pisan; la base cancela una de las dos.
 *    Para quien reserva es lo mismo: ese horario ya no está libre.
 */
export function isSlotConflict(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === "23P01" || code === "40P01";
}
