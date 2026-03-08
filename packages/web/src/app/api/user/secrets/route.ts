import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { controlPlaneFetch } from "@/lib/control-plane";

export async function GET() {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;

  try {
    const response = await controlPlaneFetch(`/users/${userId}/secrets`);
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to fetch user secrets:", error);
    return NextResponse.json({ error: "Failed to fetch secrets" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;

  try {
    const body = await request.json();

    const response = await controlPlaneFetch(`/users/${userId}/secrets`, {
      method: "PUT",
      body: JSON.stringify(body),
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to update user secrets:", error);
    return NextResponse.json({ error: "Failed to update secrets" }, { status: 500 });
  }
}
