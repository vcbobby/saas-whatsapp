export const ROLES = ["owner", "admin", "agent"] as const;
export type Role = (typeof ROLES)[number];

const MATRIX = {
  "conversations:read": ["owner", "admin", "agent"],
  "conversations:reply": ["owner", "admin", "agent"],
  "contacts:read": ["owner", "admin", "agent"],
  "contacts:edit": ["owner", "admin", "agent"],
  "contacts:manage": ["owner", "admin"],
  "feedback:send": ["owner", "admin", "agent"],
  "reports:read": ["owner", "admin"],
  "broadcasts:manage": ["owner", "admin"],
  "team:manage": ["owner", "admin"],
  "team:roles": ["owner"],
  "settings:edit": ["owner", "admin"],
  "integrations:manage": ["owner", "admin"],
  "agent:manage": ["owner", "admin"],
  "agenda:read": ["owner", "admin", "agent"],
  "agenda:manage": ["owner", "admin"],
  "agenda:book": ["owner", "admin", "agent"],
  "catalog:read": ["owner", "admin", "agent"],
  "catalog:manage": ["owner", "admin"],
  "orders:read": ["owner", "admin", "agent"],
  "orders:write": ["owner", "admin", "agent"],
  "copilot:use": ["owner", "admin"],
  "support:use": ["owner", "admin"],
  "billing:manage": ["owner"],
  "tenant:delete": ["owner"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof MATRIX;

export function can(role: Role | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return (MATRIX[permission] as readonly Role[]).includes(role);
}
