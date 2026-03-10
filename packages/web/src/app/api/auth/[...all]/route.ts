import { getAuth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

export async function GET(req: Request) {
  const auth = await getAuth();
  const { GET: handler } = toNextJsHandler(auth);
  return handler(req);
}

export async function POST(req: Request) {
  const auth = await getAuth();
  const { POST: handler } = toNextJsHandler(auth);
  return handler(req);
}
