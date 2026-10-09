"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { postJson } from "@/lib/client";

export interface MemberRow { userId: string; email: string; role: string; since: string; mfa: boolean }
export interface InvitationRow { id: string; email: string; role: string; expiresAt: string }

const ROLE_LABEL: Record<string, string> = { owner: "Dueño", admin: "Administrador", agent: "Agente" };

export function TeamPanel({
  myRole,
  myUserId,
  members,
  invitations,
}: {
  myRole: string;
  myUserId: string;
  members: MemberRow[];
  invitations: InvitationRow[];
}) {
  const router = useRouter();
  const uid = useId();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const isOwner = myRole === "owner";
  const fmt = new Intl.DateTimeFormat("es-VE", { dateStyle: "medium" });

  async function run(url: string, body: unknown) {
    setBusy(true);
    setError(null);
    const r = await postJson<{ inviteUrl?: string }>(url, body);
    setBusy(false);
    if (!r.ok) {
      setError(r.data.message ?? "No se pudo completar.");
      return null;
    }
    router.refresh();
    return r.data;
  }

  async function invite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const data = await run("/api/team/invite", { email: String(f.get("email") ?? ""), role: String(f.get("role") ?? "agent") });
    if (data?.inviteUrl) {
      setLink(data.inviteUrl);
      setCopied(false);
      form.reset();
    }
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const canRemove = (m: MemberRow) =>
    m.userId !== myUserId && m.role !== "owner" && (isOwner || m.role === "agent");

  return (
    <div className="flex flex-col gap-10">
      <section className="card-light" aria-labelledby={`${uid}-inv`}>
        <p className="eyebrow">Invitar</p>
        <h2 id={`${uid}-inv`} className="mt-3 text-[28px]">Añade a alguien</h2>
        <p className="muted mt-3">
          Te daremos un enlace para enviarle por WhatsApp o correo. Sirve 7 días, una sola vez, y solo con ese correo.
        </p>
        <form onSubmit={invite} className="mt-6 grid gap-4 md:grid-cols-[1fr_200px_auto] md:items-end">
          <div className="field">
            <label htmlFor={`${uid}-e`}>Correo</label>
            <input id={`${uid}-e`} name="email" type="email" className="input" required maxLength={254} autoComplete="off" autoCapitalize="none" spellCheck={false} />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-r`}>Rol</label>
            <select id={`${uid}-r`} name="role" className="input" defaultValue="agent">
              <option value="agent">Agente</option>
              {isOwner && <option value="admin">Administrador</option>}
            </select>
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Crear enlace
          </button>
        </form>

        {link && (
          <div className="mt-6 flex flex-col gap-3" role="status">
            <p className="alert-warn">Copia el enlace ahora: no volverá a mostrarse.</p>
            <input className="input" readOnly value={link} aria-label="Enlace de invitación" onFocus={(e) => e.currentTarget.select()} />
            <div>
              <button type="button" className="btn btn-ghost-light btn-sm" onClick={copy}>
                {copied ? "Copiado" : "Copiar enlace"}
              </button>
            </div>
          </div>
        )}
        <div role="alert" aria-live="assertive">{error && <p className="alert-error mt-4">{error}</p>}</div>
      </section>

      <section aria-labelledby={`${uid}-mem`}>
        <h2 id={`${uid}-mem`} className="text-[28px]">Equipo</h2>
        <ul className="mt-6 flex flex-col gap-4">
          {members.map((m) => (
            <li key={m.userId} className="card-dark flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-lg">{m.email}{m.userId === myUserId && <span className="muted-dark text-sm"> (tú)</span>}</p>
                <p className="muted-dark mt-1 text-sm">
                  Desde {fmt.format(new Date(m.since))} · {m.mfa ? "Verificación en dos pasos activa" : "Sin verificación en dos pasos"}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {isOwner && m.role !== "owner" ? (
                  <select
                    className="input"
                    style={{ width: "auto" }}
                    aria-label={`Rol de ${m.email}`}
                    value={m.role}
                    disabled={busy}
                    onChange={(e) => run("/api/team/role", { userId: m.userId, role: e.target.value })}
                  >
                    <option value="agent">Agente</option>
                    <option value="admin">Administrador</option>
                  </select>
                ) : (
                  <span className="badge">{ROLE_LABEL[m.role] ?? m.role}</span>
                )}
                {canRemove(m) && (
                  <button
                    type="button"
                    className="btn btn-ghost-dark btn-sm"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(`¿Quitar a ${m.email} del equipo? Perderá el acceso de inmediato.`)) {
                        void run("/api/team/remove", { userId: m.userId });
                      }
                    }}
                  >
                    Quitar
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {invitations.length > 0 && (
        <section aria-labelledby={`${uid}-pend`}>
          <h2 id={`${uid}-pend`} className="text-[28px]">Invitaciones pendientes</h2>
          <ul className="mt-6 flex flex-col gap-4">
            {invitations.map((i) => (
              <li key={i.id} className="card-dark flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-lg">{i.email}</p>
                  <p className="muted-dark mt-1 text-sm">{ROLE_LABEL[i.role]} · vence {fmt.format(new Date(i.expiresAt))}</p>
                </div>
                {(isOwner || i.role === "agent") && (
                  <button type="button" className="btn btn-ghost-dark btn-sm" disabled={busy} onClick={() => run("/api/team/invitation", { invitationId: i.id })}>
                    Cancelar
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
