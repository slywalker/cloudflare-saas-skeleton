/**
 * Zod schemas shared between server (Hono routes) and client (React forms).
 * Keep this file framework-agnostic (no Hono / D1 imports) so it can be
 * imported from src/client without pulling in server-only code.
 */
import { z } from "zod";

/** アプリのルーティング・認証で予約されているサブドメインはテナントに払い出せない。 */
export const RESERVED_TENANT_SLUGS = [
  "www",
  "api",
  "app",
  "admin",
  "auth",
  "mail",
  "ftp",
  "root",
  "localhost",
  "assets",
  "static",
  "cdn",
  "dashboard",
  "support",
  "help",
  "status",
  "blog",
  "docs",
] as const;

/** Tenant subdomain: lowercase letters, digits, hyphen. 3-63 chars (DNS label limit). */
export const tenantSlugSchema = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "英小文字・数字・ハイフンのみ使用可")
  .refine((slug) => !(RESERVED_TENANT_SLUGS as readonly string[]).includes(slug), {
    message: "このサブドメインは予約されているため使用できません",
  });

export const createTenantSchema = z.object({
  slug: tenantSlugSchema,
  name: z.string().min(1).max(200),
});
export type CreateTenantInput = z.infer<typeof createTenantSchema>;

export const tenantStatusSchema = z.enum(["provisioning", "active", "suspended", "failed"]);
export type TenantStatus = z.infer<typeof tenantStatusSchema>;

export const subscriptionPlanSchema = z.enum(["free", "pro", "enterprise"]);
export type SubscriptionPlan = z.infer<typeof subscriptionPlanSchema>;

export const subscriptionStatusSchema = z.enum([
  "active",
  "trialing",
  "past_due",
  "canceled",
  "incomplete",
]);
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

export const signUpSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(200),
});
export type SignUpInput = z.infer<typeof signUpSchema>;

export const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type SignInInput = z.infer<typeof signInSchema>;
