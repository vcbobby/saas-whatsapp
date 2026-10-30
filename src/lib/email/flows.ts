import { newSessionToken } from "@/lib/auth/tokens";
import { getPool, withTenant } from "@/lib/db";
import { clientIp } from "@/lib/security/client-ip";
import { describeDevice } from "@/lib/security/device";
import { appLink, enqueueEmail } from "./outbox";
import { emailTemplates } from "./templates";

/** Crea el enlace de verificación y encola el correo. Devuelve si se mandó (false si ya estaba verificado, hay demasiadas solicitudes o falló). Nunca lanza. */
export async function sendVerificationEmail(userId: string): Promise<boolean> {
  try {
    const { token, hash } = newSessionToken();
    const r = await getPool().query<{ email: string | null }>("SELECT auth_request_verification($1, $2) AS email", [userId, hash]);
    const email = r.rows[0]?.email;
    if (!email) return false;
    return await enqueueEmail(email, emailTemplates.verifyEmail(appLink(`/verificar/${token}`)));
  } catch (err) {
    console.error("[correo] verificación:", err instanceof Error ? err.message : err);
    return false;
  }
}

/** Recuperar contraseña: no revela si el correo existe (quien llama responde igual siempre). */
export async function sendPasswordResetEmail(email: string): Promise<void> {
  try {
    const { token, hash } = newSessionToken();
    const r = await getPool().query<{ email: string | null }>("SELECT auth_request_reset($1, $2) AS email", [email, hash]);
    const to = r.rows[0]?.email;
    if (to) await enqueueEmail(to, emailTemplates.resetPassword(appLink(`/restablecer/${token}`)));
  } catch (err) {
    console.error("[correo] recuperar contraseña:", err instanceof Error ? err.message : err);
  }
}

export async function sendPasswordChangedEmail(email: string): Promise<void> {
  await enqueueEmail(email, emailTemplates.passwordChanged());
}

export async function sendInvitationEmail(o: { tenantId: string; to: string; role: string; url: string; inviter: string }): Promise<boolean> {
  try {
    const business = await withTenant(o.tenantId, async (db) => (await db.query<{ name: string }>("SELECT name FROM tenants WHERE id = $1", [o.tenantId])).rows[0]?.name ?? "tu equipo");
    return await enqueueEmail(o.to, emailTemplates.invitation({ url: o.url, business, role: o.role, inviter: o.inviter }), { tenantId: o.tenantId });
  } catch (err) {
    console.error("[correo] invitación:", err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Avisa por correo cuando alguien completa un inicio de sesión desde un navegador o sistema que esa persona nunca había usado.
 * Se llama SOLO con el inicio de sesión ya completo (contraseña y, si lo tiene, código): así quien solo conoce la contraseña
 * no puede llenar tu bandeja. Un aviso por hora como máximo. Nunca falla ni retrasa el inicio de sesión.
 */
export async function notifyLoginDevice(userId: string, req: Request): Promise<void> {
  try {
    const device = describeDevice(req.headers.get("user-agent"));
    const ip = clientIp(req);
    const r = await getPool().query<{ is_new: boolean; user_email: string | null }>("SELECT * FROM login_device_seen($1, $2, $3, $4)", [userId, device.hash, device.label, ip]);
    const row = r.rows[0];
    if (!row?.is_new || !row.user_email) return;
    const hour = new Date().toISOString().slice(0, 13);
    await enqueueEmail(row.user_email, emailTemplates.newDevice({ device: device.label, ip, when: new Date() }), { dedupeKey: `nuevo-dispositivo:${userId}:${hour}` });
  } catch (err) {
    console.error("[correo] aviso de dispositivo nuevo:", err instanceof Error ? err.message : err);
  }
}
