/** The serve wrapper sets this flag only for dev/start, never for next build.
 * Dynamic loading keeps build-time registration away from databases and models. */
export async function bootstrapWebServer(input: {
  runtime?: string; serving?: string; embeddedWorkers?: string;
  load?: () => Promise<{ start(): Promise<void> }>;
} = {}): Promise<boolean> {
  if ((input.runtime ?? process.env.NEXT_RUNTIME) !== "nodejs" || (input.serving ?? process.env.FIELD_GUIDE_SERVE) !== "1") return false;
  const loaded = await (input.load ?? (async () => {
    const { getApplication, startApplicationWorkers, stopApplication } = await import("./application.ts");
    const { installGracefulStop } = await import("./graceful-stop.ts");
    const control = globalThis as typeof globalThis & { fieldGuideStopControl?: Promise<unknown> };
    return { async start() {
      const app = await getApplication();
      if ((input.embeddedWorkers ?? process.env.FIELD_GUIDE_EMBEDDED_WORKERS) !== "0") startApplicationWorkers(app);
      try { await (control.fieldGuideStopControl ??= installGracefulStop({ workspace: process.cwd(), shutdown: stopApplication })); }
      catch (error) { await stopApplication(); throw error; }
    } };
  }))();
  await loaded.start();
  return true;
}
