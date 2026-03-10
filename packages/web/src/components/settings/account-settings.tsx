"use client";

import { useState } from "react";
import { useSession } from "@/lib/auth-client";
import useSWR, { mutate } from "swr";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { GitHubIcon, TrashIcon } from "@/components/ui/icons";

type IdentityProvider = "linear" | "slack";

interface IdentityLink {
  provider: IdentityProvider;
  externalUserId: string;
  githubLogin: string;
  githubName: string | null;
  createdAt: number;
  updatedAt: number;
}

interface IdentityLinksResponse {
  links: IdentityLink[];
}

const PROVIDER_LABELS: Record<IdentityProvider, string> = {
  linear: "Linear",
  slack: "Slack",
};

const PROVIDER_DESCRIPTIONS: Record<IdentityProvider, string> = {
  linear:
    "Link your Linear user ID so sessions triggered from Linear issues are attributed to your GitHub account on pull requests.",
  slack:
    "Link your Slack user ID so sessions triggered from Slack are attributed to your GitHub account on pull requests.",
};

const IDENTITY_LINKS_KEY = "/api/identity-links";

export function AccountSettings() {
  const { data: session } = useSession();
  const { data, isLoading } = useSWR<IdentityLinksResponse>(session ? IDENTITY_LINKS_KEY : null);

  const [addingProvider, setAddingProvider] = useState<IdentityProvider | null>(null);
  const [externalUserId, setExternalUserId] = useState("");
  const [saving, setSaving] = useState(false);
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const links = data?.links ?? [];
  const linkedProviders = new Set(links.map((l) => l.provider));

  function startAdding(provider: IdentityProvider) {
    setAddingProvider(provider);
    setExternalUserId("");
    setError("");
    setSuccess("");
  }

  function cancelAdding() {
    setAddingProvider(null);
    setExternalUserId("");
    setError("");
  }

  async function handleSave() {
    if (!addingProvider || !externalUserId.trim()) return;

    setSaving(true);
    setError("");
    setSuccess("");

    try {
      const res = await fetch(IDENTITY_LINKS_KEY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: addingProvider,
          externalUserId: externalUserId.trim(),
        }),
      });

      if (res.ok) {
        await mutate(IDENTITY_LINKS_KEY);
        setSuccess(`${PROVIDER_LABELS[addingProvider]} account linked.`);
        setAddingProvider(null);
        setExternalUserId("");
      } else {
        const body = (await res.json()) as { error?: string };
        setError(body.error ?? "Failed to save link.");
      }
    } catch {
      setError("Failed to save link.");
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(provider: IdentityProvider, externalUserId: string) {
    const key = `${provider}:${externalUserId}`;
    setRemovingKey(key);
    setError("");
    setSuccess("");

    try {
      const res = await fetch(IDENTITY_LINKS_KEY, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, externalUserId }),
      });

      if (res.ok) {
        await mutate(IDENTITY_LINKS_KEY);
        setSuccess(`${PROVIDER_LABELS[provider]} link removed.`);
      } else {
        const body = (await res.json()) as { error?: string };
        setError(body.error ?? "Failed to remove link.");
      }
    } catch {
      setError("Failed to remove link.");
    } finally {
      setRemovingKey(null);
    }
  }

  return (
    <div>
      <h2 className="text-xl font-semibold text-foreground mb-1">Account</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Manage your identity and linked accounts.
      </p>

      {/* GitHub identity */}
      <section className="border border-border-muted rounded-md p-5 mb-5">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-foreground mb-1">
          GitHub
        </h3>
        <p className="text-sm text-muted-foreground mb-4">
          Your GitHub account is used to authenticate and attribute pull requests.
        </p>

        {session?.user ? (
          <div className="flex items-center gap-3">
            {session.user.image && (
              <Image
                src={session.user.image}
                alt={session.user.name ?? "GitHub avatar"}
                width={32}
                height={32}
                className="rounded-full"
              />
            )}
            <div>
              <p className="text-sm font-medium text-foreground flex items-center gap-1.5">
                <GitHubIcon className="w-3.5 h-3.5" />
                {session.user.name}
              </p>
              {session.user.email && (
                <p className="text-xs text-muted-foreground">{session.user.email}</p>
              )}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Not signed in.</p>
        )}
      </section>

      {/* Linked identities */}
      <section className="border border-border-muted rounded-md p-5">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-foreground mb-1">
          Linked Identities
        </h3>
        <p className="text-sm text-muted-foreground mb-4">
          Link your Slack or Linear user IDs so sessions triggered from those platforms are
          attributed to your GitHub account on pull requests.
        </p>

        {/* Status banners */}
        {error && (
          <div className="mb-4 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 px-4 py-3 border border-red-200 dark:border-red-800 text-sm rounded">
            {error}
          </div>
        )}
        {success && (
          <div className="mb-4 bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 px-4 py-3 border border-green-200 dark:border-green-800 text-sm rounded">
            {success}
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-2">
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-muted-foreground" />
            <span className="text-sm">Loading...</span>
          </div>
        ) : (
          <>
            {/* Existing links */}
            {links.length > 0 && (
              <div className="border border-border-muted rounded-md bg-background mb-4">
                <ul className="divide-y divide-border-muted">
                  {links.map((link) => {
                    const key = `${link.provider}:${link.externalUserId}`;
                    const isRemoving = removingKey === key;
                    return (
                      <li key={key} className="flex items-center justify-between px-4 py-3 gap-4">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground">
                            {PROVIDER_LABELS[link.provider]}
                          </p>
                          <p className="text-xs text-muted-foreground font-mono truncate">
                            {link.externalUserId}
                          </p>
                        </div>
                        <button
                          onClick={() => handleRemove(link.provider, link.externalUserId)}
                          disabled={isRemoving}
                          className="p-1.5 text-muted-foreground hover:text-red-500 transition disabled:opacity-40 flex-shrink-0"
                          title={`Remove ${PROVIDER_LABELS[link.provider]} link`}
                          aria-label={`Remove ${PROVIDER_LABELS[link.provider]} link`}
                        >
                          <TrashIcon className="w-4 h-4" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {/* Add form */}
            {addingProvider ? (
              <div className="border border-border-muted rounded-md p-4 bg-muted/30">
                <p className="text-sm font-medium text-foreground mb-1">
                  Link {PROVIDER_LABELS[addingProvider]}
                </p>
                <p className="text-xs text-muted-foreground mb-3">
                  {PROVIDER_DESCRIPTIONS[addingProvider]}
                </p>
                <label className="block text-sm font-medium text-foreground mb-1">
                  {PROVIDER_LABELS[addingProvider]} user ID
                </label>
                <input
                  type="text"
                  value={externalUserId}
                  onChange={(e) => setExternalUserId(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleSave();
                    if (e.key === "Escape") cancelAdding();
                  }}
                  placeholder={addingProvider === "slack" ? "U01234567" : "linear-user-id"}
                  className="w-full max-w-sm px-3 py-2 text-sm border border-border rounded-sm bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent mb-3"
                  autoFocus
                />
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={handleSave}
                    disabled={saving || !externalUserId.trim()}
                  >
                    {saving ? "Saving..." : "Save"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={cancelAdding} disabled={saving}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              /* Add buttons for unlinked providers */
              <div className="flex flex-wrap gap-2">
                {(["linear", "slack"] as const)
                  .filter((p) => !linkedProviders.has(p))
                  .map((provider) => (
                    <Button
                      key={provider}
                      size="sm"
                      variant="outline"
                      onClick={() => startAdding(provider)}
                    >
                      Link {PROVIDER_LABELS[provider]}
                    </Button>
                  ))}
                {["linear", "slack"].every((p) => linkedProviders.has(p as IdentityProvider)) && (
                  <p className="text-sm text-muted-foreground">All providers linked.</p>
                )}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
