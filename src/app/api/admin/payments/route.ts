import { getPool } from "@/lib/db";
import { requireSuperAdmin } from "@/lib/auth/guard";
import { jsonResponse, route } from "@/lib/auth/http";

const STATUSES = ["pendiente", "por_revisar", "confirmado", "rechazado", "vencido"];

/** Cola de pagos. ?status=por_revisar (por defecto). Solo súper admin. */
export const GET = route(async (req) => {
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return auth.response;
  const s = new URL(req.url).searchParams.get("status") ?? "por_revisar";
  const status = STATUSES.includes(s) ? s : "por_revisar";
  const r = await getPool().query("SELECT * FROM admin_list_payments($1, $2)", [auth.tokenHash, status]);
  return jsonResponse({
    payments: r.rows.map((x) => ({
      id: x.o_id, tenantId: x.o_tenant_id, tenantName: x.o_tenant_name, planName: x.o_plan_name, months: x.o_months, method: x.o_method,
      amountUsdCents: Number(x.o_amount_usd_cents), rate: x.o_rate === null ? null : Number(x.o_rate), amountBsCents: x.o_amount_bs_cents === null ? null : Number(x.o_amount_bs_cents),
      status: x.o_status, reference: x.o_reference, payerBank: x.o_payer_bank, payerPhone: x.o_payer_phone,
      paidOn: x.o_paid_on ? `${x.o_paid_on.getFullYear()}-${String(x.o_paid_on.getMonth() + 1).padStart(2, "0")}-${String(x.o_paid_on.getDate()).padStart(2, "0")}` : null,
      declaredCents: x.o_declared_cents === null ? null : Number(x.o_declared_cents), hasProof: x.o_has_proof,
      submittedAt: x.o_submitted_at, decidedAt: x.o_decided_at, rejectReason: x.o_reject_reason,
    })),
  });
});
