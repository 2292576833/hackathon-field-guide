import "server-only";
import { getApplication } from "../../../../server/application.ts";
import { dispatch } from "../../../../server/router.ts";
import { toErrorEnvelope } from "../../../../shared/errors.ts";
import { webRequestDrain } from "../../../../server/request-drain.ts";
import { compressPublicResponse } from "../../../../server/public-response-compression.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function route(request: Request, context: { params: Promise<{ path: string[] }> }) {
  try { return await webRequestDrain.run(async () => compressPublicResponse(request, await dispatch(await getApplication(), request, (await context.params).path))); }
  catch (error) { return Response.json(toErrorEnvelope(error, "runtime-unavailable"), { status: 503, headers: { "Cache-Control": "no-store" } }); }
}
export { route as GET, route as POST, route as PUT, route as PATCH, route as DELETE, route as OPTIONS, route as HEAD };
