"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function LogoutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function logout() {
    setPending(true);
    try {
      await fetch("/api/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    } finally {
      router.replace("/entrar");
      router.refresh();
    }
  }

  return (
    <button type="button" className="btn btn-ghost-dark btn-sm" onClick={logout} disabled={pending}>
      {pending ? "Saliendo…" : "Salir"}
    </button>
  );
}
