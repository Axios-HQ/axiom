import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const userId = session.user.id || session.user.email || "anonymous";
  const encodedSessionId = encodeURIComponent(id);
  const encodedUserId = encodeURIComponent(userId);

  try {
    const response = await controlPlaneFetch(
      `/sessions/${encodedSessionId}/artifacts?userId=${encodedUserId}`
    );
    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(data, { status: response.status });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("List artifacts error:", error);
    return NextResponse.json({ error: "Failed to list artifacts" }, { status: 500 });
  }
}
