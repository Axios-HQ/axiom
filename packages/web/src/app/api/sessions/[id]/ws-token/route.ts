import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSession, getGitHubAccessToken } from "@/lib/auth-server";
import { controlPlaneFetch } from "@/lib/control-plane";

/**
 * Generate a WebSocket authentication token for the current user.
 *
 * This endpoint:
 * 1. Verifies the user is authenticated via better-auth
 * 2. Extracts user info from the session
 * 3. Proxies the request to the control plane to generate a token
 * 4. Returns the token to the client for WebSocket connection
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const routeStart = Date.now();

  const session = await getSession(request.headers);
  const authMs = Date.now() - routeStart;

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: sessionId } = await params;

  try {
    const user = session.user;
    const userId = user.id || user.email || "anonymous";

    const tokenStart = Date.now();
    const accessToken = await getGitHubAccessToken(request.headers);
    const tokenMs = Date.now() - tokenStart;

    const fetchStart = Date.now();
    const response = await controlPlaneFetch(`/sessions/${sessionId}/ws-token`, {
      method: "POST",
      body: JSON.stringify({
        userId,
        scmUserId: user.id,
        scmName: user.name,
        scmEmail: user.email,
        scmToken: accessToken,
      }),
    });
    const fetchMs = Date.now() - fetchStart;
    const totalMs = Date.now() - routeStart;

    console.log(
      `[ws-token] session=${sessionId} total=${totalMs}ms auth=${authMs}ms token=${tokenMs}ms fetch=${fetchMs}ms status=${response.status}`
    );

    if (!response.ok) {
      const error = await response.text();
      console.error(`Failed to generate WS token: ${error}`);
      return NextResponse.json({ error: "Failed to generate token" }, { status: response.status });
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error("Failed to generate WS token:", error);
    return NextResponse.json({ error: "Failed to generate token" }, { status: 500 });
  }
}
