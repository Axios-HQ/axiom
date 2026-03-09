import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { bridgeFetch, controlPlaneFetch, extractError } from "./_bridge-client.js";
import { readFileSync } from "fs";

export default tool({
  name: "send-update",
  description:
    "Send a progress update to the user. The message appears in real-time wherever the " +
    "session was started (Slack thread, web UI, or Linear issue). Use this to report " +
    "milestones, share screenshots, or ask for input during long tasks. If a screenshot " +
    "path is provided, the image is uploaded to cloud storage and included in the update.\n\n" +
    "IMPORTANT: Before finishing your work, if you started a dev server or built a UI, " +
    "take a final screenshot with `agent-browser screenshot --path /tmp/screenshot.png` " +
    "and send it with this tool so the user can see the result.",
  args: {
    message: z.string().describe("Update message (markdown supported)"),
    screenshotPath: z
      .string()
      .optional()
      .describe(
        "Path to a screenshot file (e.g., from agent-browser screenshot --path /tmp/screenshot.png)"
      ),
  },
  async execute(args) {
    let screenshotUrl = null;

    if (args.screenshotPath) {
      let buffer;
      try {
        buffer = readFileSync(args.screenshotPath);
      } catch (e) {
        return `Failed to read screenshot at ${args.screenshotPath}: ${e.message}`;
      }

      let uploadResp;
      try {
        uploadResp = await controlPlaneFetch("/api/media/upload", {
          method: "POST",
          headers: {
            "Content-Type": "image/png",
            "X-Filename": "screenshot.png",
          },
          body: buffer,
        });
      } catch (e) {
        return `Screenshot upload failed: ${e.message}`;
      }

      if (!uploadResp.ok) {
        const err = await extractError(uploadResp);
        return `Screenshot upload failed (${uploadResp.status}): ${err}`;
      }

      try {
        const { url } = await uploadResp.json();
        screenshotUrl = url;
      } catch {
        return "Screenshot upload failed: could not parse response";
      }
    }

    let response;
    try {
      response = await bridgeFetch("/agent-update", {
        method: "POST",
        body: JSON.stringify({
          message: args.message,
          screenshotUrl,
        }),
      });
    } catch (e) {
      return `Failed to send update: ${e.message}`;
    }

    if (!response.ok) {
      const err = await extractError(response);
      return `Failed to send update (${response.status}): ${err}`;
    }

    return screenshotUrl
      ? `Update sent with screenshot: ${screenshotUrl}`
      : "Update sent to the user.";
  },
});
