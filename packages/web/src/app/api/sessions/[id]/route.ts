import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { controlPlaneFetch } from "@/lib/control-plane";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const userId = session.user.id || session.user.email || "anonymous";

  try {
    // Archive the session in the control plane (soft delete)
    const archiveResponse = await controlPlaneFetch(`/sessions/${id}/archive`, {
      method: "POST",
      body: JSON.stringify({ userId }),
    });

    if (!archiveResponse.ok) {
      const data = await archiveResponse.json();
      return NextResponse.json(data, { status: archiveResponse.status });
    }

    return NextResponse.json({ status: "archived", sessionId: id });
  } catch (error) {
    console.error("Delete session error:", error);
    return NextResponse.json({ error: "Failed to delete session" }, { status: 500 });
  }
}
