import { gzip } from "node:zlib";
import { promisify } from "node:util";

const zip = promisify(gzip);
const publicCatalogs = /^\/api\/v1\/(?:event-discoveries(?:\/[^/]+)?|inspiration)$/;
function acceptsGzip(value: string): boolean {
  const encodings = value.toLowerCase().split(",").map(part => {
    const [name, ...parameters] = part.trim().split(";");
    const quality = parameters.find(parameter => parameter.trim().startsWith("q="));
    const q = quality ? Number(quality.trim().slice(2)) : 1;
    return { name: name.trim(), q: Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0 };
  });
  return (encodings.find(item => item.name === "gzip") ?? encodings.find(item => item.name === "*"))?.q! > 0;
}

/** Next's streamed route responses were sent uncompressed over the tunnel.
 * Only these public catalog GETs are eligible; private/session/mail data are not. */
export async function compressPublicResponse(request: Request, response: Response): Promise<Response> {
  if (request.method !== "GET" || !publicCatalogs.test(new URL(request.url).pathname) ||
      response.status !== 200 || response.headers.has("content-encoding") || response.headers.has("set-cookie") ||
      !response.headers.get("content-type")?.startsWith("application/json") ||
      !acceptsGzip(request.headers.get("accept-encoding") ?? "")) return response;
  const body = new Uint8Array(await response.arrayBuffer());
  const headers = new Headers(response.headers);
  const vary = headers.get("vary");
  if (!vary?.split(",").some(value => value.trim().toLowerCase() === "accept-encoding")) headers.set("vary", [vary, "Accept-Encoding"].filter(Boolean).join(", "));
  if (body.length < 1024 || body.length > 2 * 1024 * 1024) return new Response(body, { status: response.status, headers });
  const compressed = await zip(body, { level: 4 });
  if (compressed.length >= body.length) return new Response(body, { status: response.status, headers });
  headers.set("content-encoding", "gzip");
  headers.set("content-length", String(compressed.length));
  headers.delete("etag");
  return new Response(new Uint8Array(compressed), { status: response.status, headers });
}
