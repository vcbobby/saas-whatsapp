import Link from "next/link";
import { PLAN_MODULE_LABEL, type PlanModule } from "@/lib/plans/usage";

/** Se muestra en lugar de una pantalla cuyo módulo no incluye el plan del negocio. */
export function ModuleLocked({ module }: { module: PlanModule }) {
  return (
    <section className="card-light mt-8" style={{ maxWidth: 640 }} role="status">
      <p className="eyebrow">No incluido en tu plan</p>
      <h2 className="mt-3 text-[28px]">{PLAN_MODULE_LABEL[module]}</h2>
      <p className="muted mt-3">
        Tu plan actual no incluye este módulo. Tus datos están a salvo: no se borra nada. Escríbenos para cambiar de plan y volver a usarlo.
      </p>
      <p className="mt-4"><Link href="/panel" className="link">Ver mi plan</Link></p>
    </section>
  );
}
