"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function StopImpersonationButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function stop() {
    setPending(true);
    try {
      await fetch("/api/admin/impersonation", { method: "DELETE" });
    } finally {
      router.replace("/admin");
      router.refresh();
    }
  }

  return (
    <button type="button" className="btn btn-ghost-light btn-sm" onClick={stop} disabled={pending}>
      {pending ? "Saliendo…" : "Salir del negocio"}
    </button>
  );
}
