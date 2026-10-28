import type IORedis from "ioredis";
import { getSecurityEnv } from "@/lib/env";
import { createProducerConnection, queuePrefix } from "@/lib/queue/connection";
import { UNKNOWN_IP } from "./client-ip";

/**
 * Límites de peticiones por IP. Los números son ajustables aquí mismo.
 * Ojo: en Venezuela muchas personas comparten una misma IP (operadoras móviles), por eso los límites
 * de entrar/registrarse son holgados: frenan a un robot, no a una oficina.
 */
export const POLICIES = {
  api: { limit: 600, windowSec: 60 }, // cualquier ruta de la API
  login: { limit: 30, windowSec: 300 }, // /api/auth/login
  mfa: { limit: 30, windowSec: 300 }, // verificar código de 2 pasos
  password: { limit: 10, windowSec: 600 }, // cambiar la contraseña (pide la actual: frena adivinarla)
  recover: { limit: 8, windowSec: 3600 }, // pedir el enlace para recuperar la contraseña (además cada cuenta admite 3 por hora)
  verifyEmail: { limit: 15, windowSec: 3600 }, // pedir o usar enlaces de verificación de correo
  templates: { limit: 40, windowSec: 3600 }, // crear, actualizar o borrar plantillas de WhatsApp (llaman a Meta)
  signup: { limit: 10, windowSec: 3600 }, // crear cuentas (cada cuenta nueva puede gastar IA en la prueba)
  privacy: { limit: 5, windowSec: 3600 }, // descargar o borrar todos los datos (cada intento pide la contraseña)
  support: { limit: 20, windowSec: 600 }, // crear o responder tickets de soporte
  invite: { limit: 20, windowSec: 3600 }, // aceptar / crear cuenta con invitación
  badSignature: { limit: 10, windowSec: 60 }, // firmas falsas en el webhook de WhatsApp
} as const;

export type PolicyName = keyof typeof POLICIES;

export interface LimitResult {
  allowed: boolean;
  retryAfterSec: number;
  source: "redis" | "memory" | "off";
}

/** Si la IP es desconocida, todas comparten cupo: se amplía para no bloquear a todos por culpa de uno. */
const UNKNOWN_MULTIPLIER = 20;

const effectiveLimit = (policy: PolicyName, ip: string) =>
  POLICIES[policy].limit * (ip === UNKNOWN_IP ? UNKNOWN_MULTIPLIER : 1);

// ------------------------------------------------------------------ Redis
// Contador atómico: suma 1 y, si es el primero de la ventana, le pone vencimiento. Devuelve [cuenta, ms restantes].
const HIT_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if c == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {c, ttl}
`;

let redis: IORedis | null = null;
let lastWarn = 0;

function getRedis(): IORedis {
  redis ??= createProducerConnection();
  return redis;
}

export async function closeRateLimit(): Promise<void> {
  if (redis) {
    redis.disconnect();
    redis = null;
  }
}

function warnRedis(err: unknown) {
  if (Date.now() - lastWarn < 60_000) return;
  lastWarn = Date.now();
  console.error(
    "[límite] Redis no responde; se usa un límite en memoria (menos preciso):",
    err instanceof Error ? err.message : err,
  );
}

const key = (policy: PolicyName, ip: string) => `${queuePrefix()}:rl:${policy}:${ip}`;

// ---------------------------------------------------------------- memoria
// Plan B si Redis falla: protege mientras tanto, aunque cada proceso cuente por separado.
const MAX_MEMORY_KEYS = 10_000;
const memory = new Map<string, { count: number; resetAt: number }>();

function memoryGet(k: string, now: number) {
  const e = memory.get(k);
  if (e && e.resetAt <= now) {
    memory.delete(k);
    return undefined;
  }
  return e;
}

function memoryHit(k: string, windowMs: number): { count: number; ttlMs: number } {
  const now = Date.now();
  if (memory.size >= MAX_MEMORY_KEYS) {
    for (const [mk, v] of memory) if (v.resetAt <= now) memory.delete(mk);
    if (memory.size >= MAX_MEMORY_KEYS) memory.clear(); // ataque masivo: mejor olvidar que agotar la memoria
  }
  const e = memoryGet(k, now);
  if (!e) {
    memory.set(k, { count: 1, resetAt: now + windowMs });
    return { count: 1, ttlMs: windowMs };
  }
  e.count += 1;
  return { count: e.count, ttlMs: e.resetAt - now };
}

export function resetMemoryLimits(): void {
  memory.clear();
}

// -------------------------------------------------------------------- API
const OFF: LimitResult = { allowed: true, retryAfterSec: 0, source: "off" };

/** Cuenta una petición y dice si todavía está dentro del límite. */
export async function hitLimit(policy: PolicyName, ip: string): Promise<LimitResult> {
  if (getSecurityEnv().rateLimitDisabled) return OFF;
  const { windowSec } = POLICIES[policy];
  const max = effectiveLimit(policy, ip);
  const k = key(policy, ip);
  try {
    const [count, ttlMs] = (await getRedis().eval(HIT_SCRIPT, 1, k, String(windowSec * 1000))) as [number, number];
    return { allowed: count <= max, retryAfterSec: Math.max(1, Math.ceil(ttlMs / 1000)), source: "redis" };
  } catch (err) {
    warnRedis(err);
    const m = memoryHit(k, windowSec * 1000);
    return { allowed: m.count <= max, retryAfterSec: Math.max(1, Math.ceil(m.ttlMs / 1000)), source: "memory" };
  }
}

/** Mira si ya se pasó del límite SIN contar una petición más. */
export async function peekLimit(policy: PolicyName, ip: string): Promise<LimitResult> {
  if (getSecurityEnv().rateLimitDisabled) return OFF;
  const max = effectiveLimit(policy, ip);
  const k = key(policy, ip);
  try {
    const r = getRedis();
    const [raw, ttlMs] = await Promise.all([r.get(k), r.pttl(k)]);
    const count = raw ? Number(raw) : 0;
    return { allowed: count < max, retryAfterSec: Math.max(1, Math.ceil(Math.max(ttlMs, 0) / 1000)), source: "redis" };
  } catch (err) {
    warnRedis(err);
    const e = memoryGet(k, Date.now());
    const count = e?.count ?? 0;
    return { allowed: count < max, retryAfterSec: Math.max(1, Math.ceil(((e?.resetAt ?? Date.now()) - Date.now()) / 1000)), source: "memory" };
  }
}
