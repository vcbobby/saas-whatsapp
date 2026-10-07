import { hash, verify } from "@node-rs/argon2";

// Argon2id con los parámetros mínimos recomendados por OWASP
// (19 MiB de memoria, 2 pasadas, 1 hilo).
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

// Normaliza para que "é" escrita de dos formas distintas sea la misma clave.
const normalize = (password: string) => password.normalize("NFKC");

export function hashPassword(password: string): Promise<string> {
  return hash(normalize(password), OPTIONS);
}

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, normalize(password));
  } catch {
    return false; // hash corrupto o con formato inesperado
  }
}

// Hash falso que se calcula una vez. Cuando el correo no existe se verifica
// contra este, para que tardar lo mismo no delate qué correos están registrados.
let dummy: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummy ??= hash("contraseña-que-nadie-usa", OPTIONS);
  await verifyPassword(await dummy, password);
}
