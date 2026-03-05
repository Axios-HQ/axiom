import { createHmac } from "node:crypto";

function parseArgs(argv) {
  const args = {
    mode: null,
    domain: "axioshq.com",
    overrideManual: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") args.mode = "dry-run";
    if (arg === "--apply") args.mode = "apply";
    if (arg === "--override-manual") args.overrideManual = true;
    if (arg === "--domain") {
      args.domain = argv[i + 1] || args.domain;
      i += 1;
    }
  }

  return args;
}

function internalToken(secret) {
  const timestamp = Date.now().toString();
  const signature = createHmac("sha256", secret).update(timestamp).digest("hex");
  return `${timestamp}.${signature}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.mode) {
    throw new Error("Specify exactly one of --dry-run or --apply");
  }

  const baseUrl = process.env.CONTROL_PLANE_URL;
  const internalSecret = process.env.INTERNAL_CALLBACK_SECRET;

  if (!baseUrl) {
    throw new Error("CONTROL_PLANE_URL is required");
  }
  if (!internalSecret) {
    throw new Error("INTERNAL_CALLBACK_SECRET is required");
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/identity-links/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${internalToken(internalSecret)}`,
    },
    body: JSON.stringify({
      mode: args.mode,
      domain: args.domain,
      overrideManual: args.overrideManual,
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Sync failed (${response.status}): ${JSON.stringify(payload)}`);
  }

  const linked = payload?.linked ?? 0;
  const skipped = payload?.skipped ?? 0;
  const conflicted = payload?.conflicted ?? 0;

  process.stdout.write(
    `identity link sync (${args.mode}) complete\nlinked=${linked} skipped=${skipped} conflicted=${conflicted}\n`
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
