import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { controlPlaneFetch } from "@/lib/control-plane";

export async function DELETE(_request: Request, { params }: { params: Promise<{ key: string }> }) {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;
  const { key } = await params;

  try {
    const response = await controlPlaneFetch(
      `/users/${userId}/secrets/${encodeURIComponent(key)}`,
      { method: "DELETE" }
    );

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to delete user secret:", error);
    return NextResponse.json({ error: "Failed to delete secret" }, { status: 500 });
  }
}
