import { createHmac } from "node:crypto";

function parseArgs(argv) {
  const args = {
    mode: null,
    domain: process.env.IDENTITY_LINK_SYNC_DOMAIN?.trim().toLowerCase() || null,
    overrideManual: false,
  };

  let hasDryRun = false;
  let hasApply = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      hasDryRun = true;
      args.mode = "dry-run";
    }
    if (arg === "--apply") {
      hasApply = true;
      args.mode = "apply";
    }
    if (arg === "--override-manual") args.overrideManual = true;
    if (arg === "--domain") {
      const domainValue = argv[i + 1];
      if (!domainValue || domainValue.startsWith("--")) {
        throw new Error("--domain requires a value");
      }
      args.domain = domainValue.trim().toLowerCase();
      i += 1;
    }
  }

  if (hasDryRun && hasApply) {
    throw new Error("--dry-run and --apply are mutually exclusive; specify exactly one");
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
  if (!args.domain) {
    throw new Error("domain is required (--domain or IDENTITY_LINK_SYNC_DOMAIN env var)");
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
