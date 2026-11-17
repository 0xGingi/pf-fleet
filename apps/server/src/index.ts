import { websocket } from "hono/bun";
import { createApp } from "./app";
import { loadBundle } from "./bundle";
import { Auth } from "./auth";
import { Sealer } from "./crypto";
import { openDb } from "./db";
import { loadEnv } from "./env";
import { Hub } from "./hub";

let env;
try {
  env = loadEnv();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

const db = openDb(env.DATABASE_PATH);
const sealer = new Sealer(env.APP_SECRET);
const bundle = loadBundle(env.AGENT_DIR);
if (!bundle.version) console.warn(`pf-fleet: no agent build in ${env.AGENT_DIR}; install commands and agent updates are unavailable`);
const hub = new Hub(db, sealer, bundle);
const auth = new Auth(db, {
  user: env.ADMIN_USER,
  password: env.ADMIN_PASSWORD,
  passwordHash: env.ADMIN_PASSWORD_HASH,
  secureCookie: env.PUBLIC_URL.startsWith("https://"),
  sessionDays: env.SESSION_DAYS,
});

const app = createApp({ db, hub, auth, sealer, env, dashboardVersion: env.APP_VERSION });

const server = Bun.serve({
  port: env.PORT,
  fetch: app.fetch,
  websocket: { ...websocket, idleTimeout: 120, sendPings: true },
  // SSE streams send a ping every 20 s
  idleTimeout: 60,
});

console.log(
  `pf-fleet ${env.APP_VERSION} on http://localhost:${server.port} (public URL ${env.PUBLIC_URL}; agent ${bundle.version ?? "missing"} for ${Object.keys(bundle.binaries).join(", ") || "no CPUs"})`,
);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.stop();
    process.exit(0);
  });
}
