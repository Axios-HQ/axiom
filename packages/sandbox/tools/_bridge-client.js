/* global process, fetch */
const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL || "http://localhost:8787";
const SANDBOX_AUTH_TOKEN = process.env.SANDBOX_AUTH_TOKEN || "";
const SESSION_ID = process.env.SESSION_ID || "";

/** Make an authenticated request to the control plane, scoped to the current session. */
export async function bridgeFetch(path, options = {}) {
  if (!SESSION_ID) {
    throw new Error("SESSION_ID environment variable is required");
  }

  const url = `${CONTROL_PLANE_URL}/sessions/${SESSION_ID}${path}`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${SANDBOX_AUTH_TOKEN}`,
    ...options.headers,
  };

  return fetch(url, { ...options, headers });
}

/** Make an authenticated request to the control plane (no session prefix). */
export async function controlPlaneFetch(path, options = {}) {
  const url = `${CONTROL_PLANE_URL}${path}`;
  const headers = {
    Authorization: `Bearer ${SANDBOX_AUTH_TOKEN}`,
    ...options.headers,
  };

  return fetch(url, { ...options, headers });
}

/** Extract a human-readable error message from a non-OK response. */
export async function extractError(response) {
  const text = await response.text();
  try {
    const json = JSON.parse(text);
    return json.error || json.message || text;
  } catch {
    return text;
  }
}
