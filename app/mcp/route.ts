import { timingSafeEqual } from "node:crypto";
import { handleMcpRequest } from "@/lib/mcp";

// Vercel Hobby supports at most 300 seconds per invocation.
export const runtime = "nodejs";
export const maxDuration = 300;

function isAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) {
    return true;
  }

  const requestOrigin = new URL(request.url).origin;
  return (
    origin === requestOrigin ||
    origin === "https://chatgpt.com" ||
    origin === "https://chat.openai.com" ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  );
}

function reject(status: number, message: string, headers?: HeadersInit): Response {
  return Response.json({ error: message }, { status, headers });
}

function requireBearerToken(request: Request): Response | null {
  // No authentication configuration must never mean public tool access.
  const expected = process.env.MCP_BEARER_TOKEN;
  if (!expected || expected.length < 32) {
    return reject(503, "MCP authentication has not been configured");
  }

  const header = request.headers.get("Authorization") || "";
  const match = /^Bearer ([^\s]+)$/.exec(header);
  const unauthorized = () => reject(401, "Unauthorized", {
    "WWW-Authenticate": 'Bearer realm="mcp-daytona"',
    "Cache-Control": "no-store",
  });
  if (!match) return unauthorized();

  const providedBytes = Buffer.from(match[1], "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (providedBytes.length !== expectedBytes.length || !timingSafeEqual(providedBytes, expectedBytes)) {
    return unauthorized();
  }
  return null;
}

export async function POST(request: Request): Promise<Response> {
  if (!isAllowedOrigin(request)) {
    return reject(403, "Origin not allowed");
  }
  const authError = requireBearerToken(request);
  if (authError) return authError;

  return handleMcpRequest(request);
}

export function GET(request: Request): Response {
  if (!isAllowedOrigin(request)) {
    return reject(403, "Origin not allowed");
  }
  const authError = requireBearerToken(request);
  if (authError) return authError;

  return new Response(null, {
    status: 405,
    headers: { Allow: "POST" },
  });
}
