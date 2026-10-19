"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { BUSINESS_TYPE_INFO, BUSINESS_TYPES, COUNTRY_CODES, COUNTRY_INFO, EMOJI_LABEL, EMOJI_LEVELS, TONE_LABEL, TONES, type BusinessType, type CountryCode, type EmojiLevel, type Tone } from "@/lib/agent/style";
import { CURRENCY_INFO, parseMoney } from "@/lib/catalog/money";
import { COUNTRY_DEFAULTS, effectiveType, MAX_ITEMS, parseHourRange, WEEKDAY_LABEL, type OnboardingInput } from "@/lib/onboarding/schema";
import type { PlanModule } from "@/lib/plans/usage";

const STEPS = ["Tu negocio", "Lo que ofreces", "Horario y datos", "Tu asistente", "Revisar y listo"] as const;
const MINUTES = [15, 20, 30, 45, 60, 90, 120];

interface Props { businessName: string; modules: PlanModule[] }
interface ServiceRow { name: string; minutes: number; price: string }
interface ProductRow { name: string; price: string }

const blankService = (): ServiceRow => ({ name: "", minutes: 30, price: "" });
const blankProduct = (): ProductRow => ({ name: "", price: "" });

/** Asistente de bienvenida: 5 pantallas que dejan la cuenta lista para usar. */
export function Welcome({ businessName, modules }: Props) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [type, setType] = useState<BusinessType>(modules.includes("agenda") ? "citas" : modules.includes("catalogo") ? "catalogo" : "atencion");
  const [country, setCountry] = useState<CountryCode>("VE");
  const [services, setServices] = useState<ServiceRow[]>([blankService()]);
  const [products, setProducts] = useState<ProductRow[]>([blankProduct()]);
  const [offer, setOffer] = useState("");
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("18:00");
  const [hoursText, setHoursText] = useState("");
  const [address, setAddress] = useState("");
  const [payments, setPayments] = useState("");
  const [other, setOther] = useState("");
  const [name, setName] = useState("Asistente");
  const [tone, setTone] = useState<Tone>("cercano");
  const [emoji, setEmoji] = useState<EmojiLevel>("pocos");
  const [activate, setActivate] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  // Al cambiar de pantalla el foco pasa al título (para lectores de pantalla y teclado); al abrir la página no.
  const prev = useRef({ step: 0, done: false });
  useEffect(() => {
    if (prev.current.step !== step || prev.current.done !== done) heading.current?.focus();
    prev.current = { step, done };
  }, [step, done]);
  const hp = { id: "w-title", ref: heading, tabIndex: -1, style: { outline: "none" } } as const;

  const currency = COUNTRY_DEFAULTS[country].currency;
  const allowed = (t: BusinessType) => effectiveType(t, modules) === t;

  function validate(s: number): string | null {
    if (s === 1 && type === "citas") {
      const rows = services.filter((r) => r.name.trim());
      if (rows.length === 0) return "Añade al menos un servicio (por ejemplo «Consulta»).";
    }
    if (s === 1 && type === "catalogo") {
      const rows = products.filter((r) => r.name.trim());
      if (rows.length === 0) return "Añade al menos un producto.";
      if (rows.some((r) => parseMoney(r.price) === null)) return "Revisa los precios: usa números como 10 o 10,50.";
    }
    if (s === 2 && type === "citas") {
      if (days.length === 0) return "Marca al menos un día en que atiendes.";
      const r = parseHourRange(start, end);
      if (typeof r === "string") return r;
    }
    if (s === 3 && !name.trim()) return "Ponle un nombre a tu asistente.";
    return null;
  }

  function next() {
    const e = validate(step);
    setError(e);
    if (!e) setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }
  function back() { setError(null); setStep((s) => Math.max(0, s - 1)); }

  async function finish() {
    for (let s = 0; s < STEPS.length; s++) {
      const e = validate(s);
      if (e) { setError(e); setStep(s); return; }
    }
    setBusy(true);
    setError(null);
    const payload: OnboardingInput = {
      businessType: type,
      country,
      services: type === "citas" ? services.filter((r) => r.name.trim()).map((r) => ({ name: r.name.trim(), durationMinutes: r.minutes, ...(r.price.trim() ? { priceText: r.price.trim() } : {}) })) : [],
      products: type === "catalogo" ? products.filter((r) => r.name.trim()).map((r) => ({ name: r.name.trim(), priceMinor: parseMoney(r.price) ?? 0 })) : [],
      hours: type === "citas" ? { days, start, end } : null,
      info: { offer: type === "atencion" ? offer : "", hours: type === "citas" ? "" : hoursText, address, payments, other },
      assistantName: name.trim(),
      tone,
      emojiLevel: emoji,
      activate,
    };
    try {
      const res = await fetch("/api/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      if (res.ok) setDone(true);
      else if (res.status === 409) router.replace("/panel");
      else setError(data.message ?? "No se pudo guardar. Intenta de nuevo.");
    } catch {
      setError("No hay conexión con el servidor. Revisa tu internet e intenta de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  async function skip() {
    setBusy(true);
    try { await fetch("/api/onboarding/skip", { method: "POST" }); } finally { router.replace("/panel"); }
  }

  if (done) {
    return (
      <section className="card-light w-full" style={{ maxWidth: 640 }} aria-labelledby="w-title">
        <p className="eyebrow">¡Listo!</p>
        <h1 {...hp} className="mt-3 text-[32px]">Tu cuenta quedó configurada</h1>
        <p className="muted mt-3">{activate ? "Tu asistente ya está activado. " : "Tu asistente quedó apagado: actívalo cuando quieras desde «Mi asistente». "}Los últimos pasos:</p>
        <ol className="mt-6 grid gap-4" style={{ paddingLeft: 20 }}>
          <li><strong>Pruébalo</strong> sin gastar mensajes: <Link href="/simulador" className="link">chatea con tu asistente aquí</Link>.</li>
          <li><strong>Conecta tu WhatsApp</strong> para que atienda a tus clientes: <Link href="/whatsapp" className="link">conectar mi número</Link>.</li>
          <li>Añade más detalle cuando quieras en <Link href="/conocimiento" className="link">Conocimiento</Link> (preguntas frecuentes).</li>
        </ol>
        <div className="mt-8"><Link href="/panel" className="btn btn-primary">Ir a mi panel</Link></div>
      </section>
    );
  }

  const last = step === STEPS.length - 1;
  return (
    <section className="card-light w-full" style={{ maxWidth: 640 }} aria-labelledby="w-title">
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow">Paso {step + 1} de {STEPS.length}</p>
        <p className="muted text-[13px]">{STEPS[step]}</p>
      </div>
      <div role="progressbar" aria-label="Avance" aria-valuemin={1} aria-valuemax={STEPS.length} aria-valuenow={step + 1} className="mt-3" style={{ height: 6, borderRadius: 6, background: "rgba(19,35,34,0.15)" }}>
        <div style={{ width: `${((step + 1) / STEPS.length) * 100}%`, height: 6, borderRadius: 6, background: "var(--color-ink)" }} />
      </div>

      {step === 0 && (
        <div className="mt-6 grid gap-6">
          <div>
            <h1 {...hp} className="text-[28px]">Bienvenido a {businessName}</h1>
            <p className="muted mt-2">En 5 pasos cortos dejamos tu cuenta lista. Primero, cuéntanos cómo trabajas.</p>
          </div>
          <fieldset className="grid gap-3" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="mb-2 text-[14px] font-medium">¿Cómo trabaja tu negocio?</legend>
            {BUSINESS_TYPES.map((t) => (
              <label key={t} className="flex items-start gap-3" style={{ border: "1.5px solid var(--color-field-border)", borderRadius: 14, padding: 14, cursor: allowed(t) ? "pointer" : "not-allowed", opacity: allowed(t) ? 1 : 0.6, background: type === t ? "#fff" : "transparent", outline: type === t ? "2px solid var(--color-ink)" : "none" }}>
                <input type="radio" name="type" value={t} checked={type === t} disabled={!allowed(t)} onChange={() => setType(t)} style={{ marginTop: 5 }} />
                <span>
                  <strong>{BUSINESS_TYPE_INFO[t].label}</strong>
                  <span className="muted block text-[14px]">{BUSINESS_TYPE_INFO[t].description}{!allowed(t) && " (No incluido en tu plan)"}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="field">
            <label htmlFor="w-country">¿En qué país estás?</label>
            <select id="w-country" className="input" value={country} onChange={(e) => setCountry(e.target.value as CountryCode)}>
              {COUNTRY_CODES.map((c) => <option key={c} value={c}>{COUNTRY_INFO[c].label}</option>)}
            </select>
            <p className="hint">Define la hora de tu negocio ({COUNTRY_DEFAULTS[country].timezone}) y cómo habla tu asistente.</p>
          </div>
        </div>
      )}

      {step === 1 && type === "citas" && (
        <div className="mt-6 grid gap-5">
          <div>
            <h1 {...hp} className="text-[28px]">¿Qué servicios das?</h1>
            <p className="muted mt-2">Tus clientes podrán pedir cita para estos servicios. Luego puedes añadir más en Agenda.</p>
          </div>
          {services.map((r, i) => (
            <div key={i} className="grid gap-3 sm:grid-cols-[1fr_130px_110px_auto] sm:items-end" role="group" aria-label={`Servicio ${i + 1}`}>
              <div className="field"><label htmlFor={`s-n-${i}`}>Servicio</label><input id={`s-n-${i}`} className="input" maxLength={80} placeholder="Ej: Consulta" value={r.name} onChange={(e) => setServices((l) => l.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} /></div>
              <div className="field"><label htmlFor={`s-m-${i}`}>Duración</label><select id={`s-m-${i}`} className="input" value={r.minutes} onChange={(e) => setServices((l) => l.map((x, j) => (j === i ? { ...x, minutes: Number(e.target.value) } : x)))}>{MINUTES.map((m) => <option key={m} value={m}>{m} min</option>)}</select></div>
              <div className="field"><label htmlFor={`s-p-${i}`}>Precio</label><input id={`s-p-${i}`} className="input" maxLength={40} placeholder="Ej: $20" value={r.price} onChange={(e) => setServices((l) => l.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} /></div>
              {services.length > 1 && <button type="button" className="btn btn-text btn-sm" aria-label={`Quitar servicio ${i + 1}`} onClick={() => setServices((l) => l.filter((_, j) => j !== i))}>Quitar</button>}
            </div>
          ))}
          {services.length < MAX_ITEMS && <div><button type="button" className="btn btn-ghost-light btn-sm" onClick={() => setServices((l) => [...l, blankService()])}>+ Añadir otro servicio</button></div>}
        </div>
      )}

      {step === 1 && type === "catalogo" && (
        <div className="mt-6 grid gap-5">
          <div>
            <h1 {...hp} className="text-[28px]">¿Qué vendes?</h1>
            <p className="muted mt-2">Pon tus productos principales con su precio en {CURRENCY_INFO[currency].label}. Luego añades el resto, con stock y fotos, en Catálogo.</p>
          </div>
          {products.map((r, i) => (
            <div key={i} className="grid gap-3 sm:grid-cols-[1fr_150px_auto] sm:items-end" role="group" aria-label={`Producto ${i + 1}`}>
              <div className="field"><label htmlFor={`p-n-${i}`}>Producto</label><input id={`p-n-${i}`} className="input" maxLength={120} placeholder="Ej: Torta de chocolate" value={r.name} onChange={(e) => setProducts((l) => l.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} /></div>
              <div className="field"><label htmlFor={`p-p-${i}`}>Precio ({CURRENCY_INFO[currency].prefix.trim()})</label><input id={`p-p-${i}`} className="input" inputMode="decimal" placeholder="10,50" value={r.price} onChange={(e) => setProducts((l) => l.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} /></div>
              {products.length > 1 && <button type="button" className="btn btn-text btn-sm" aria-label={`Quitar producto ${i + 1}`} onClick={() => setProducts((l) => l.filter((_, j) => j !== i))}>Quitar</button>}
            </div>
          ))}
          {products.length < MAX_ITEMS && <div><button type="button" className="btn btn-ghost-light btn-sm" onClick={() => setProducts((l) => [...l, blankProduct()])}>+ Añadir otro producto</button></div>}
        </div>
      )}

      {step === 1 && type === "atencion" && (
        <div className="mt-6 grid gap-5">
          <div>
            <h1 {...hp} className="text-[28px]">¿A qué se dedica tu negocio?</h1>
            <p className="muted mt-2">Cuéntalo en pocas líneas, como se lo explicarías a un cliente nuevo.</p>
          </div>
          <div className="field">
            <label htmlFor="w-offer">Descripción</label>
            <textarea id="w-offer" className="input" rows={5} maxLength={600} placeholder="Ej: Somos una escuela de inglés para adultos en Valencia. Damos clases presenciales y en línea…" value={offer} onChange={(e) => setOffer(e.target.value)} />
            <p className="hint">{offer.length}/600</p>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="mt-6 grid gap-5">
          <div>
            <h1 {...hp} className="text-[28px]">{type === "citas" ? "¿Cuándo atiendes?" : "Datos que tus clientes preguntan"}</h1>
            <p className="muted mt-2">Tu asistente responderá con esto. Todo es opcional salvo lo marcado.</p>
          </div>
          {type === "citas" ? (
            <>
              <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="mb-2 text-[14px] font-medium">Días en que atiendes</legend>
                <div className="flex flex-wrap gap-2">
                  {WEEKDAY_LABEL.map((l, i) => {
                    const d = i + 1;
                    const on = days.includes(d);
                    return <button key={d} type="button" aria-pressed={on} className={on ? "btn btn-primary btn-sm" : "btn btn-ghost-light btn-sm"} onClick={() => setDays((x) => (on ? x.filter((v) => v !== d) : [...x, d].sort()))}>{l}</button>;
                  })}
                </div>
              </fieldset>
              <div className="grid grid-cols-2 gap-4">
                <div className="field"><label htmlFor="w-start">Abres a las</label><input id="w-start" type="time" className="input" value={start} onChange={(e) => setStart(e.target.value)} /></div>
                <div className="field"><label htmlFor="w-end">Cierras a las</label><input id="w-end" type="time" className="input" value={end} onChange={(e) => setEnd(e.target.value)} /></div>
              </div>
              <p className="hint muted text-[13px]">Si tienes descanso al mediodía o horarios distintos por día, afínalo después en Agenda.</p>
            </>
          ) : (
            <div className="field"><label htmlFor="w-hours">Horario de atención</label><input id="w-hours" className="input" maxLength={300} placeholder="Ej: Lunes a sábado de 8:00 a 17:00" value={hoursText} onChange={(e) => setHoursText(e.target.value)} /></div>
          )}
          <div className="field"><label htmlFor="w-address">Dirección o zona</label><input id="w-address" className="input" maxLength={300} placeholder="Ej: Av. Bolívar, frente a la plaza, Valencia" value={address} onChange={(e) => setAddress(e.target.value)} /></div>
          <div className="field"><label htmlFor="w-pay">Formas de pago</label><input id="w-pay" className="input" maxLength={300} placeholder="Ej: Efectivo, Pago Móvil, transferencia" value={payments} onChange={(e) => setPayments(e.target.value)} /></div>
          <div className="field"><label htmlFor="w-other">Algo más que tus clientes suelen preguntar</label><textarea id="w-other" className="input" rows={3} maxLength={600} placeholder="Ej: Hacemos delivery en toda la ciudad. Cancelaciones con 24 horas de aviso." value={other} onChange={(e) => setOther(e.target.value)} /></div>
        </div>
      )}

      {step === 3 && (
        <div className="mt-6 grid gap-5">
          <div>
            <h1 {...hp} className="text-[28px]">Conoce a tu asistente</h1>
            <p className="muted mt-2">Así se presentará y hablará con tus clientes por WhatsApp.</p>
          </div>
          <div className="field"><label htmlFor="w-name">Nombre del asistente</label><input id="w-name" className="input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} /></div>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="mb-2 text-[14px] font-medium">¿Cómo habla?</legend>
            <div className="flex flex-wrap gap-4">{TONES.map((t) => <label key={t} className="flex items-center gap-2"><input type="radio" name="tone" checked={tone === t} onChange={() => setTone(t)} />{TONE_LABEL[t]}</label>)}</div>
          </fieldset>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="mb-2 text-[14px] font-medium">Emojis</legend>
            <div className="flex flex-wrap gap-4">{EMOJI_LEVELS.map((t) => <label key={t} className="flex items-center gap-2"><input type="radio" name="emoji" checked={emoji === t} onChange={() => setEmoji(t)} />{EMOJI_LABEL[t]}</label>)}</div>
          </fieldset>
        </div>
      )}

      {step === 4 && (
        <div className="mt-6 grid gap-5">
          <div>
            <h1 {...hp} className="text-[28px]">Revisa y termina</h1>
            <p className="muted mt-2">Esto es lo que vamos a configurar. Podrás cambiarlo todo después.</p>
          </div>
          <dl className="grid gap-3 text-[15px]">
            <div><dt className="muted text-[13px]">Negocio</dt><dd>{businessName} · {COUNTRY_INFO[country].label} · {BUSINESS_TYPE_INFO[type].label}</dd></div>
            {type === "citas" && <div><dt className="muted text-[13px]">Servicios</dt><dd>{services.filter((r) => r.name.trim()).map((r) => `${r.name.trim()} (${r.minutes} min)`).join(", ") || "—"}</dd></div>}
            {type === "citas" && <div><dt className="muted text-[13px]">Horario</dt><dd>{days.length ? `${days.map((d) => WEEKDAY_LABEL[d - 1]).join(", ")} · ${start} a ${end}` : "—"}</dd></div>}
            {type === "catalogo" && <div><dt className="muted text-[13px]">Productos</dt><dd>{products.filter((r) => r.name.trim()).map((r) => r.name.trim()).join(", ") || "—"}</dd></div>}
            <div><dt className="muted text-[13px]">Asistente</dt><dd>{name.trim() || "—"} · {TONE_LABEL[tone]} · emojis: {EMOJI_LABEL[emoji].toLowerCase()}</dd></div>
          </dl>
          <label className="flex items-start gap-3"><input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} style={{ marginTop: 5 }} /><span><strong>Activar el asistente al terminar</strong><span className="muted block text-[14px]">Empezará a responder en cuanto conectes tu WhatsApp. Puedes apagarlo cuando quieras.</span></span></label>
        </div>
      )}

      {error && <p className="alert-error mt-6" role="alert">{error}</p>}

      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-3">
          {step > 0 && <button type="button" className="btn btn-ghost-light" onClick={back} disabled={busy}>Atrás</button>}
          {last ? (
            <button type="button" className="btn btn-primary" onClick={finish} disabled={busy}>{busy ? "Guardando…" : "Terminar y configurar"}</button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={next} disabled={busy}>Continuar</button>
          )}
        </div>
        <button type="button" className="btn btn-text" onClick={skip} disabled={busy}>Lo haré después</button>
      </div>
    </section>
  );
}
