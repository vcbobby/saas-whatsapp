"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";

export function TenantActions({ tenantId, status }: { tenantId: string; status: string }) {
  const router = useRouter();
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function send(url: string, body: unknown) {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(data?.message ?? "No se pudo completar.");
        return false;
      }
      return true;
    } catch {
      setError("Sin conexión.");
      return false;
    } finally {
      setPending(false);
    }
  }

  async function enter(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const reason = String(new FormData(e.currentTarget).get("reason") ?? "");
    if (await send("/api/admin/impersonation", { tenantId, reason })) {
      router.push("/panel");
      router.refresh();
    }
  }

  async function toggleSuspend() {
    const next = status === "suspended" ? "active" : "suspended";
    const verb = next === "suspended" ? "suspender" : "reactivar";
    if (!window.confirm(`¿Seguro que quieres ${verb} este negocio?`)) return;
    if (await send("/api/admin/tenant-status", { tenantId, status: next })) router.refresh();
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          Entrar como soporte
        </button>
        <button type="button" className="btn btn-ghost-dark btn-sm" onClick={toggleSuspend} disabled={pending}>
          {status === "suspended" ? "Reactivar" : "Suspender"}
        </button>
      </div>
      {open && (
        <form onSubmit={enter} className="flex flex-col gap-2">
          <label htmlFor={`${uid}-motivo`} className="text-sm">
            Motivo (queda registrado y lo ve el dueño)
          </label>
          <textarea
            id={`${uid}-motivo`}
            name="reason"
            required
            minLength={10}
            maxLength={500}
            rows={2}
            className="input"
            style={{ background: "#fff" }}
            placeholder="Ej.: Ticket 123, revisar configuración del horario"
          />
          <button type="submit" className="btn btn-primary btn-sm self-start" disabled={pending}>
            {pending ? "Entrando…" : "Confirmar y entrar"}
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-sm" style={{ color: "var(--color-danger-on-dark)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
