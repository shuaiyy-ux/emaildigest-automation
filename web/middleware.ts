import { NextRequest, NextResponse } from "next/server";
import { isDemoMode } from "./lib/demo";

/**
 * Simple bearer token auth for public access via Cloudflare Tunnel.
 * Token is set via EMAILDIGEST_AUTH_TOKEN env var.
 *
 * DEMO_MODE: the demo gateway in front of the app authenticates visitors and
 * the app listens on 127.0.0.1 only, so the token check below is skipped.
 * The /api/internal/* loopback gate still applies (and is stricter).
 */
export function middleware(request: NextRequest) {
  function addSecurityHeaders(response: NextResponse) {
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("X-Frame-Options", "DENY");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    response.headers.set("Cross-Origin-Resource-Policy", "same-origin");
    response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
    if (request.nextUrl.protocol === "https:") {
      response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
    }
    return response;
  }

  const path = request.nextUrl.pathname;

  // Localhost-only internal API (called by the MCP server subprocess
  // during Ask AI tool use). Accept only requests whose Host header maps to
  // loopback — external CF tunnel traffic sets Host to the public hostname.
  const host = request.headers.get("host") || "";
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  const loopbackHost = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";

  if (isDemoMode()) {
    if (path.startsWith("/api/internal/")) {
      // Anything the gateway forwards carries X-Demo-User (it always sets
      // it), and anything that crossed Cloudflare carries CF-Connecting-IP.
      // The MCP server calls 127.0.0.1 directly with neither. (Not
      // X-Forwarded-For: the Next server adds that to every request itself.)
      const proxied =
        request.headers.has("x-demo-user") ||
        request.headers.has("cf-connecting-ip");
      if (!loopbackHost || proxied) {
        return addSecurityHeaders(new NextResponse("Not found", { status: 404 }));
      }
    }
    return addSecurityHeaders(NextResponse.next());
  }

  const token = process.env.EMAILDIGEST_AUTH_TOKEN;
  if (!token) return addSecurityHeaders(NextResponse.next()); // No token set = no auth

  // Allow Next.js internals, static assets, and PWA shell files. Manifest /
  // sw.js / icons must be reachable without auth: the browser fetches them
  // outside the user's session (manifest before login, SW with no cookies
  // in some flows). Contents are non-sensitive (name, start_url, plain JS).
  if (
    path.startsWith("/_next/") ||
    path.startsWith("/favicon") ||
    path === "/login" ||
    path === "/manifest.json" ||
    path === "/sw.js" ||
    path === "/apple-touch-icon.png" ||
    /^\/icon-\d+(-maskable)?\.png$/.test(path)
  ) {
    return addSecurityHeaders(NextResponse.next());
  }

  if (path.startsWith("/api/internal/") && loopbackHost) {
    return addSecurityHeaders(NextResponse.next());
  }
  // Otherwise /api/internal/* falls through to auth (effectively blocks external access)

  // Check cookie first (for browser sessions)
  const cookieToken = request.cookies.get("auth_token")?.value;
  if (cookieToken === token) return addSecurityHeaders(NextResponse.next());

  // Check Authorization header (for API calls)
  const authHeader = request.headers.get("authorization") ?? "";
  const bearerToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : "";
  if (bearerToken === token) return addSecurityHeaders(NextResponse.next());

  // Check query param (for initial login)
  const queryToken = request.nextUrl.searchParams.get("token");
  if (queryToken === token) {
    const response = NextResponse.redirect(new URL("/", request.url));
    response.cookies.set("auth_token", token, {
      httpOnly: true,
      // `secure` only in production so localhost http dev can authenticate.
      // In prod (Cloudflare Tunnel), requests always arrive over https.
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30, // 30 days
    });
    return addSecurityHeaders(response);
  }

  // Unauthorized — return simple login page
  const response = new NextResponse(
    `<!DOCTYPE html>
<html><head><title>EmailDigest Login</title>
<style>body{display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0a0a0a;color:#e5e5e5;font-family:system-ui}
form{text-align:center}input{padding:8px 16px;margin:8px;border:1px solid #333;background:#1a1a1a;color:#e5e5e5;border-radius:4px}
button{padding:8px 24px;background:#3b82f6;color:white;border:none;border-radius:4px;cursor:pointer}</style></head>
<body><form onsubmit="location.href='/?token='+document.getElementById('t').value;return false">
<h2>EmailDigest</h2><p><input id="t" placeholder="Token" type="password" autofocus></p>
<button type="submit">Login</button></form></body></html>`,
    { status: 401, headers: { "content-type": "text/html" } }
  );
  return addSecurityHeaders(response);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
