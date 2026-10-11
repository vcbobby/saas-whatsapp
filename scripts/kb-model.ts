// Descarga (la primera vez) y comprueba el modelo de búsqueda local. Ejecuta:  npm run kb:model
// Es el paso que confirma que el modelo REAL funciona en tu computadora/servidor.
process.env.EMBEDDINGS_PROVIDER = "local";
process.env.EMBEDDINGS_ALLOW_DOWNLOAD ??= "1";

export {};

async function main() {
  const { createLocalEmbedder, EMBEDDING_DIMS, LOCAL_MODEL } = await import("../src/lib/kb/embeddings");

  const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0); // ya vienen normalizados

  console.log(`Modelo: ${LOCAL_MODEL} (la primera vez descarga ~120 MB; luego queda guardado en .cache/models)`);
  const emb = createLocalEmbedder();
  const t0 = Date.now();
  const passages = await emb.embed(
    [
      "Horario de atención: lunes a viernes de 8am a 5pm, sábados de 9am a 1pm.",
      "Política de devoluciones: aceptamos cambios dentro de los 30 días con factura.",
      "Formas de pago: efectivo, Pago Móvil y transferencia.",
    ],
    "passage",
  );
  console.log(`Carga + 3 textos: ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  const checks: [string, number][] = [
    ["¿A qué hora abren?", 0],
    ["¿Puedo devolver un producto?", 1],
    ["¿Aceptan pago móvil?", 2],
  ];
  let ok = true;
  for (const [q, want] of checks) {
    const [qv] = await emb.embed([q], "query");
    if (qv!.length !== EMBEDDING_DIMS) throw new Error(`Dimensión inesperada: ${qv!.length}`);
    const sims = passages.map((p) => cos(qv!, p));
    const best = sims.indexOf(Math.max(...sims));
    const pass = best === want;
    ok &&= pass;
    console.log(`${pass ? "✔" : "✖"} «${q}» → fragmento ${best + 1} (similitudes: ${sims.map((s) => s.toFixed(3)).join(", ")})`);
  }
  if (!ok) {
    console.error("✖ El modelo no ordenó bien los resultados. Pégame esta salida.");
    process.exit(1);
  }
  console.log("✔ Modelo listo. Para usarlo: EMBEDDINGS_PROVIDER=local en .env.local y, en la pantalla Conocimiento, «Volver a indexar todo».");
}

main().catch((err) => {
  console.error("✖", err instanceof Error ? err.message : err);
  process.exit(1);
});
