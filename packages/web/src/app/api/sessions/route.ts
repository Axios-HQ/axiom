import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSession, getGitHubAccessToken } from "@/lib/auth-server";
import { controlPlaneFetch } from "@/lib/control-plane";

export async function GET(request: NextRequest) {
  const routeStart = Date.now();

  const session = await getSession();
  const authMs = Date.now() - routeStart;

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const searchParams = request.nextUrl.searchParams;
  const queryString = searchParams.toString();
  const path = queryString ? `/sessions?${queryString}` : "/sessions";

  try {
    const fetchStart = Date.now();
    const response = await controlPlaneFetch(path);
    const fetchMs = Date.now() - fetchStart;
    const data = await response.json();
    const totalMs = Date.now() - routeStart;

    console.log(
      `[sessions:GET] total=${totalMs}ms auth=${authMs}ms fetch=${fetchMs}ms status=${response.status}`
    );

    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to fetch sessions:", error);
    return NextResponse.json({ error: "Failed to fetch sessions" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();

    const accessToken = await getGitHubAccessToken(request.headers);

    // Validate optional sessionRepos field
    if (body.sessionRepos !== undefined && body.sessionRepos !== null) {
      if (!Array.isArray(body.sessionRepos)) {
        return NextResponse.json({ error: "sessionRepos must be an array" }, { status: 400 });
      }
      if (body.sessionRepos.length > 2) {
        return NextResponse.json(
          { error: "sessionRepos supports a maximum of 2 repositories" },
          { status: 400 }
        );
      }
      for (let i = 0; i < body.sessionRepos.length; i++) {
        const repo = body.sessionRepos[i];
        if (
          !repo ||
          typeof repo !== "object" ||
          typeof repo.repoOwner !== "string" ||
          repo.repoOwner.trim().length === 0 ||
          typeof repo.repoName !== "string" ||
          repo.repoName.trim().length === 0
        ) {
          return NextResponse.json(
            { error: `sessionRepos[${i}] must have non-empty string repoOwner and repoName` },
            { status: 400 }
          );
        }
        if (repo.editable !== undefined && typeof repo.editable !== "boolean") {
          return NextResponse.json(
            { error: `sessionRepos[${i}].editable must be a boolean` },
            { status: 400 }
          );
        }
      }
    }

    // Validate optional allowSecondaryRepoEdit field
    if (
      body.allowSecondaryRepoEdit !== undefined &&
      typeof body.allowSecondaryRepoEdit !== "boolean"
    ) {
      return NextResponse.json(
        { error: "allowSecondaryRepoEdit must be a boolean" },
        { status: 400 }
      );
    }

    // Derive identity from server-side session (not client-supplied data)
    const user = session.user;
    const userId = user.id || user.email || "anonymous";

    const sessionBody = {
      repoOwner: body.repoOwner,
      repoName: body.repoName,
      sessionRepos: body.sessionRepos,
      allowSecondaryRepoEdit: body.allowSecondaryRepoEdit,
      model: body.model,
      reasoningEffort: body.reasoningEffort,
      branch: body.branch,
      title: body.title,
      scmToken: accessToken,
      userId,
      scmUserId: user.id,
      scmLogin: user.login,
      scmName: user.name,
      scmEmail: user.email,
    };

    const response = await controlPlaneFetch("/sessions", {
      method: "POST",
      body: JSON.stringify(sessionBody),
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to create session:", error);
    return NextResponse.json({ error: "Failed to create session" }, { status: 500 });
  }
}
