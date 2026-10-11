import path from "node:path";
import { createHash } from "node:crypto";
import { getEmbeddingsEnv } from "@/lib/env";

/** Dimensión de los vectores. Debe coincidir con la columna vector(384) de la base. */
export const EMBEDDING_DIMS = 384;
export const LOCAL_MODEL = "Xenova/multilingual-e5-small";

export interface Embedder {
  /** Se guarda junto a cada vector: nunca se comparan vectores de modelos distintos. */
  model: string;
  embed(texts: string[], kind: "query" | "passage"): Promise<number[][]>;
}

function assertVectors(rows: unknown, expected: number): number[][] {
  if (!Array.isArray(rows) || rows.length !== expected) throw new Error("El modelo devolvió una cantidad inesperada de vectores");
  for (const v of rows) {
    if (!Array.isArray(v) || v.length !== EMBEDDING_DIMS || v.some((x) => typeof x !== "number" || !Number.isFinite(x))) {
      throw new Error("El modelo devolvió un vector inválido");
    }
  }
  return rows as number[][];
}

// ---------------------------------------------------------------------------- fake
const tokenize = (t: string) => t.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").match(/[a-z0-9ñ]{2,}/g) ?? [];

/**
 * Vectores de prueba: bolsa de palabras con hash (sin red, sin modelo, determinista).
 * Sirve para probar TODO el flujo; no entiende sinónimos ni significado.
 */
export function createFakeEmbedder(): Embedder {
  return {
    model: "fake:hash-384-v1",
    async embed(texts) {
      return texts.map((text) => {
        const v = new Array<number>(EMBEDDING_DIMS).fill(0);
        for (const w of tokenize(text)) {
          const h = createHash("sha256").update(w).digest();
          v[h.readUInt16BE(0) % EMBEDDING_DIMS]! += 1; // cuenta de palabras
        }
        const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
        // Texto sin palabras: vector fijo (no cero) para no romper la distancia coseno.
        if (norm === 0) { v[0] = 1; return v; }
        return v.map((x) => x / norm);
      });
    },
  };
}

// ---------------------------------------------------------------------------- local (transformers.js)
type Extractor = (inputs: string[], opts: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist(): unknown }>;
let extractorPromise: Promise<Extractor> | null = null;
let chain: Promise<unknown> = Promise.resolve();

async function loadExtractor(): Promise<Extractor> {
  const cfg = getEmbeddingsEnv();
  // Import dinámico: el modelo y sus librerías nativas solo se cargan donde hacen falta (el worker).
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = path.resolve(cfg.modelDir);
  env.allowRemoteModels = cfg.allowDownload;
  const ex = await pipeline("feature-extraction", LOCAL_MODEL, { dtype: "q8" });
  return ex as unknown as Extractor;
}

/** E5 pide anteponer "query: " a las preguntas y "passage: " a los textos guardados. */
export function createLocalEmbedder(): Embedder {
  return {
    model: `local:${LOCAL_MODEL}:q8`,
    async embed(texts, kind) {
      if (texts.length === 0) return [];
      extractorPromise ??= loadExtractor().catch((err) => { extractorPromise = null; throw err; });
      const ex = await extractorPromise;
      const out: number[][] = [];
      // Una llamada a la vez (el modelo no es reentrante) y en lotes chicos para acotar la memoria.
      const run = async () => {
        for (let i = 0; i < texts.length; i += 8) {
          const batch = texts.slice(i, i + 8).map((t) => `${kind}: ${t}`);
          const res = await ex(batch, { pooling: "mean", normalize: true });
          out.push(...assertVectors(res.tolist(), batch.length));
        }
      };
      const mine = chain.then(run, run);
      chain = mine.catch(() => undefined);
      await mine;
      return out;
    },
  };
}

export function getEmbedder(): Embedder {
  return getEmbeddingsEnv().EMBEDDINGS_PROVIDER === "local" ? createLocalEmbedder() : createFakeEmbedder();
}

/** Texto → literal de pgvector ("[0.1,0.2,…]") para pasarlo como parámetro con ::vector. */
export function toVectorLiteral(v: number[]): string {
  if (v.length !== EMBEDDING_DIMS || v.some((x) => !Number.isFinite(x))) throw new Error("Vector inválido");
  return `[${v.join(",")}]`;
}
