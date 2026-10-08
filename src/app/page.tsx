import Link from "next/link";
import { brand } from "@/config/brand";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="container-app flex h-20 items-center justify-between">
        <span className="text-lg font-medium" style={{ letterSpacing: "-0.01em" }}>
          {brand.name}
        </span>
        <nav className="flex items-center gap-2" aria-label="Principal">
          <Link href="/entrar" className="btn btn-text">
            Entrar
          </Link>
          <Link href="/registro" className="btn btn-primary btn-sm">
            Probar gratis
          </Link>
        </nav>
      </header>

      <main className="container-app flex flex-1 flex-col justify-center py-16">
        <p className="eyebrow eyebrow--dark">Atención por WhatsApp</p>
        <h1 className="mt-4 max-w-3xl text-[40px] sm:text-[56px]" style={{ lineHeight: 1.1 }}>
          Un agente que atiende a tus clientes y agenda sus citas.
        </h1>
        <p className="muted-dark mt-6 max-w-xl text-lg">
          Responde mensajes, registra a cada cliente y te pasa la conversación cuando hace falta una persona.
        </p>
        <div className="mt-10 flex flex-wrap gap-4">
          <Link href="/registro" className="btn btn-primary">
            Empezar 7 días gratis
          </Link>
          <Link href="/entrar" className="btn btn-ghost-dark">
            Ya tengo cuenta
          </Link>
        </div>
      </main>
    </div>
  );
}
