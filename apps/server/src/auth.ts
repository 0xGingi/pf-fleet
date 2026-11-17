import { and, eq, gt, lt } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { randomToken, safeEqual, sha256 } from "./crypto";
import { type Db, schema } from "./db";

const COOKIE = "pf_session";
/** Browsers cannot send this header cross-site without a CORS preflight we never answer: CSRF guard. */
export const CSRF_HEADER = "x-pf-fleet";

export class Auth {
  private passwordHash: Promise<string>;
  private attempts = new Map<string, { count: number; reset: number }>();

  constructor(
    private db: Db,
    private opts: { user: string; password?: string; passwordHash?: string; secureCookie: boolean; sessionDays: number },
  ) {
    this.passwordHash = opts.passwordHash
      ? Promise.resolve(opts.passwordHash)
      : Bun.password.hash(opts.password ?? randomToken(), { algorithm: "argon2id" });
  }

  /** 10 tries per 15 minutes per client. */
  private limited(ip: string): boolean {
    const now = Date.now();
    const a = this.attempts.get(ip);
    if (!a || a.reset < now) {
      this.attempts.set(ip, { count: 1, reset: now + 15 * 60_000 });
      return false;
    }
    a.count++;
    return a.count > 10;
  }

  async login(c: Context, ip: string, user: string, password: string): Promise<"ok" | "bad" | "limited"> {
    if (this.limited(ip)) return "limited";
    const userOk = safeEqual(user, this.opts.user);
    const passOk = await Bun.password.verify(password, await this.passwordHash);
    if (!userOk || !passOk) return "bad";
    this.attempts.delete(ip);
    const token = randomToken();
    const now = Date.now();
    const expiresAt = now + this.opts.sessionDays * 86_400_000;
    this.db.insert(schema.sessions).values({ idHash: sha256(token), createdAt: now, expiresAt }).run();
    this.db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, now)).run();
    setCookie(c, COOKIE, token, {
      httpOnly: true,
      sameSite: "Lax",
      secure: this.opts.secureCookie,
      path: "/",
      expires: new Date(expiresAt),
    });
    return "ok";
  }

  logout(c: Context) {
    const token = getCookie(c, COOKIE);
    if (token) this.db.delete(schema.sessions).where(eq(schema.sessions.idHash, sha256(token))).run();
    deleteCookie(c, COOKIE, { path: "/" });
  }

  isAuthed(c: Context): boolean {
    const token = getCookie(c, COOKIE);
    if (!token) return false;
    const row = this.db
      .select({ idHash: schema.sessions.idHash })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.idHash, sha256(token)), gt(schema.sessions.expiresAt, Date.now())))
      .get();
    return !!row;
  }

  /** Session required; state-changing requests also need the CSRF header. */
  guard(): MiddlewareHandler {
    return async (c, next) => {
      if (!this.isAuthed(c)) return c.json({ error: "sign in first" }, 401);
      if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.header(CSRF_HEADER) !== "1") {
        return c.json({ error: `missing ${CSRF_HEADER} header` }, 403);
      }
      await next();
    };
  }
}
