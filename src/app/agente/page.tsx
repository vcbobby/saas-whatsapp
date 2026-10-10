import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AgentSettings } from "@/components/AgentSettings";
import { AppHeader, ROLE_LABEL } from "@/components/AppHeader";
import { withTenant } from "@/lib/db";
import { getLlmEnv } from "@/lib/env";
import { can } from "@/lib/auth/permissions";
import { effectiveTenant, getSessionFromHeaders } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Asistente" };

export default function AgentPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <AgentContent />
    </Suspense>
  );
}

async function AgentContent() {
  const auth = await getSessionFromHeaders(await headers());
  if (!auth) redirect("/entrar");
  const { session } = auth;
  if (session.needsMfaSetup) redirect("/seguridad");
  const ctx = effectiveTenant(session);
  if (!ctx) redirect("/panel");

  const llm = getLlmEnv();
  const data = await withTenant(ctx.tenantId, async (db) => {
    const a = await db.query<{ enabled: boolean; assistant_name: string; instructions: string }>(
      "SELECT enabled, assistant_name, instructions FROM tenant_agents WHERE tenant_id = $1",
      [ctx.tenantId],
    );
    const wa = await db.query("SELECT 1 FROM tenant_integrations WHERE provider = 'whatsapp'");
    const n = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM messages
        WHERE tenant_id = $1 AND direction = 'out' AND reply_to IS NOT NULL AND send_state <> 'failed'
          AND created_at >= (date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc')`,
      [ctx.tenantId],
    );
    return { agent: a.rows[0], whatsapp: wa.rowCount === 1, replies: n.rows[0]?.n ?? 0 };
  });

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader
        email={session.email}
        roleLabel={ctx.impersonating ? "Soporte" : ROLE_LABEL[ctx.role]}
        showAdmin={session.isSuperAdmin}
        showTeam={can(ctx.role, "team:manage")}
      />
      <main className="container-app flex-1 pb-24 pt-8">
        <p className="eyebrow eyebrow--dark">Tu negocio</p>
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Asistente</h1>
        <div className="mt-10">
          <AgentSettings
            enabled={data.agent?.enabled ?? false}
            assistantName={data.agent?.assistant_name ?? "Asistente"}
            instructions={data.agent?.instructions ?? ""}
            canManage={can(ctx.role, "agent:manage")}
            whatsappConnected={data.whatsapp}
            mockMode={llm.LLM_PROVIDER === "mock"}
            repliesToday={data.replies}
            dailyLimit={llm.AGENT_DAILY_REPLY_LIMIT}
          />
        </div>
      </main>
    </div>
  );
}
