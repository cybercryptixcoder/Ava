import { buildApp } from "./app";
import { formatConfigReport } from "./config/config";
import { buildServer } from "./http/server";
import { seedTestProfile } from "./fixtures/seed";

async function main() {
  const app = buildApp();
  const { svc } = app;
  // The startup configuration check: what's present, what's missing, what's off as a result.
  console.log(formatConfigReport(svc.cfg));
  if (svc.cfg.profile === "test" && !svc.db.get("SELECT id FROM items LIMIT 1")) {
    const at = await seedTestProfile(svc);
    console.log(`Seeded the test profile with fixture data; simulated clock set to ${at}`);
  }
  if (svc.cfg.profile === "test") {
    const anchor = svc.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'sim.clock'");
    if (anchor && "set" in svc.clock) (svc.clock as unknown as { set(d: string): void }).set(anchor.value);
  }
  app.start();
  const server = await buildServer(svc, { logger: false });
  await server.listen({ port: svc.cfg.port, host: svc.cfg.host });
  console.log(`Ava is listening on http://${svc.cfg.host}:${svc.cfg.port} (public URL ${svc.cfg.publicUrl})`);
  const shutdown = async () => {
    if (svc.clock.simulated) {
      svc.db.run("INSERT INTO settings (key, value, updated_at) VALUES ('sim.clock', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [svc.clock.now().toISOString(), new Date().toISOString()]);
    }
    await server.close();
    app.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
