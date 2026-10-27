export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.FIELD_GUIDE_SERVE === "1") {
    const { bootstrapWebServer } = await import("./server/startup.ts");
    await bootstrapWebServer();
    console.info(`[backend] Application initialized; background mode: ${process.env.FIELD_GUIDE_EMBEDDED_WORKERS === "0" ? "separate worker" : "server owned"}.`);
  }
}
