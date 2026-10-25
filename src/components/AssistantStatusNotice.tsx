import Link from "next/link";
import { loadAssistantBlockers, type BlockerCode } from "@/lib/agent/status";

/** Explica por qué el asistente no está respondiendo. No muestra nada si todo está en orden. */
export async function AssistantStatusNotice({ tenantId, exclude = [] }: { tenantId: string; exclude?: BlockerCode[] }) {
  const blockers = (await loadAssistantBlockers(tenantId).catch(() => [])).filter((b) => !exclude.includes(b.code));
  if (blockers.length === 0) return null;
  return (
    <div className="mt-8 grid gap-3" style={{ maxWidth: 720 }} aria-label="Estado del asistente">
      {blockers.map((b) => (
        <p key={b.code} className={b.level === "error" ? "alert-error" : "alert-warn"} role={b.level === "error" ? "alert" : "status"}>
          {b.text} {b.href && <Link href={b.href} className="link">{b.hrefLabel}</Link>}
        </p>
      ))}
    </div>
  );
}
