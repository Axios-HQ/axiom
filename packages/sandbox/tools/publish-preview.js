import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { bridgeFetch, extractError } from "./_bridge-client.js";

export default tool({
  name: "publish-preview",
  description:
    "Publish a live preview URL for a running service so it appears in the session UI " +
    "and is included in Slack/Linear completion summaries. Use this after you start a " +
    "dev server or deploy a service. In multi-repo sessions, specify the repo field so " +
    "the preview is correctly attributed. Call this again with status='stopped' when " +
    "the service is no longer running.",
  args: {
    url: z.string().url().describe("Public HTTPS URL of the running service."),
    label: z
      .string()
      .min(1)
      .max(64)
      .describe(
        "Short human-readable name for the service, e.g. 'frontend', 'api', 'storybook'. " +
          "Re-publishing with the same label updates the existing preview entry."
      ),
    repo: z
      .string()
      .optional()
      .describe(
        "Repository this preview belongs to in 'owner/name' format. Required for " +
          "multi-repo sessions to correctly attribute the preview."
      ),
    status: z
      .enum(["active", "outdated", "stopped"])
      .default("active")
      .describe("Current status of the service."),
  },
  async execute(args) {
    let response;
    try {
      response = await bridgeFetch("/preview-url", {
        method: "POST",
        body: JSON.stringify({
          url: args.url,
          label: args.label,
          repo: args.repo ?? null,
          status: args.status ?? "active",
        }),
      });
    } catch (e) {
      return `Failed to publish preview: ${e.message}`;
    }

    if (!response.ok) {
      const err = await extractError(response);
      return `Failed to publish preview (${response.status}): ${err}`;
    }

    return `Preview URL published: ${args.url} (label: ${args.label}, status: ${args.status ?? "active"})`;
  },
});
