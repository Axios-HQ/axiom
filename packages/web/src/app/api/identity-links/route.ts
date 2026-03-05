import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const response = await controlPlaneFetch(
    `/identity-links?githubUserId=${encodeURIComponent(session.user.id)}`
  );
  const data = await response.json();
  return NextResponse.json(data, { status: response.status });
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !session.user.login) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as {
    provider?: "linear" | "slack";
    externalUserId?: string;
  };

  if (!body.provider || !body.externalUserId) {
    return NextResponse.json(
      { error: "provider and externalUserId are required" },
      { status: 400 }
    );
  }

  const response = await controlPlaneFetch("/identity-links", {
    method: "POST",
    body: JSON.stringify({
      provider: body.provider,
      externalUserId: body.externalUserId,
      githubUserId: session.user.id,
      githubLogin: session.user.login,
      githubName: session.user.name,
      createdBy: `github:${session.user.id}`,
    }),
  });
  const data = await response.json();
  return NextResponse.json(data, { status: response.status });
}

export async function DELETE(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as {
    provider?: "linear" | "slack";
    externalUserId?: string;
  };

  if (!body.provider || !body.externalUserId) {
    return NextResponse.json(
      { error: "provider and externalUserId are required" },
      { status: 400 }
    );
  }

  const response = await controlPlaneFetch(
    `/identity-links/${encodeURIComponent(body.provider)}/${encodeURIComponent(body.externalUserId)}`,
    {
      method: "DELETE",
    }
  );
  const data = await response.json();
  return NextResponse.json(data, { status: response.status });
}
