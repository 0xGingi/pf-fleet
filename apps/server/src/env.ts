import { z } from "zod";

const Env = z
  .object({
    PORT: z.coerce.number().int().positive().default(1337),
    DATABASE_PATH: z.string().default("./data/fleet.db"),
    /** Where the dashboard is reachable from your nodes, e.g. https://fleet.example.com. Used in install commands. */
    PUBLIC_URL: z.url().transform((u) => u.replace(/\/+$/, "")),
    ADMIN_USER: z.string().min(1).default("admin"),
    /** Plain password (hashed at startup) or an argon2/bcrypt hash from `bun -e 'console.log(await Bun.password.hash("..."))'`. */
    ADMIN_PASSWORD: z.string().optional(),
    ADMIN_PASSWORD_HASH: z.string().optional(),
    /** Encrypts Pirate Face keys at rest. Changing it makes stored keys unreadable. */
    APP_SECRET: z.string().min(32, "APP_SECRET must be at least 32 characters (try: openssl rand -hex 32)"),
    /** Directory with the built agent binaries (pf-fleet-agent-<arch>) and VERSION. */
    AGENT_DIR: z.string().default("./agent-dist"),
    /** Built web app. Empty in development (Vite serves it). */
    WEB_DIR: z.string().default(""),
    /** Trust X-Forwarded-For for client IPs (set when behind a reverse proxy). */
    TRUST_PROXY: z
      .enum(["0", "1", "true", "false"])
      .default("0")
      .transform((v) => v === "1" || v === "true"),
    SESSION_DAYS: z.coerce.number().int().positive().default(30),
    /** Set by the image build (the release tag). */
    APP_VERSION: z.string().default("dev"),
  })
  .refine((e) => e.ADMIN_PASSWORD || e.ADMIN_PASSWORD_HASH, {
    message: "set ADMIN_PASSWORD or ADMIN_PASSWORD_HASH",
  });

export type Env = z.infer<typeof Env>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join(".") || "env"}: ${i.message}`).join("\n");
    throw new Error(`pf-fleet: bad configuration\n${problems}`);
  }
  return parsed.data;
}
