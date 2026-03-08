"use client";

import { useState } from "react";
import type { Artifact } from "@/types/session";
import { GlobeIcon, KeyIcon, CopyIcon, CheckIcon } from "@/components/ui/icons";
import { copyToClipboard } from "@/lib/format";

interface PreviewsSectionProps {
  artifacts: Artifact[];
  /** code-server credentials from the authenticated WS channel (never persisted). */
  codeServer?: { url: string; password: string } | null;
}

/**
 * Render all preview and code-server artifacts in the right sidebar.
 *
 * Preview artifacts are upserted by label so the list stays compact even
 * when services restart.  The code-server block shows its URL from the
 * `preview` artifact and the password from in-memory WS state.
 */
export function PreviewsSection({ artifacts, codeServer }: PreviewsSectionProps) {
  const [copiedLabel, setCopiedLabel] = useState<string | null>(null);

  const previewArtifacts = artifacts.filter(
    (a) => a.type === "preview" && a.url && a.metadata?.kind !== "code_server"
  );
  const codeServerArtifact = artifacts.find(
    (a) => a.type === "preview" && a.metadata?.kind === "code_server"
  );

  const hasContent = previewArtifacts.length > 0 || codeServerArtifact || codeServer;

  if (!hasContent) return null;

  const handleCopy = async (text: string, label: string) => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopiedLabel(label);
      setTimeout(() => setCopiedLabel(null), 2000);
    }
  };

  const statusBadge = (status?: string) => {
    if (!status || status === "active") return null;
    const color = status === "stopped" ? "text-muted-foreground" : "text-warning-foreground";
    return <span className={`text-xs ml-1 ${color}`}>{status}</span>;
  };

  return (
    <div className="space-y-2">
      {/* Preview URLs */}
      {previewArtifacts.map((artifact) => {
        const label = artifact.metadata?.label ?? "preview";
        const repo = artifact.metadata?.repo;
        return (
          <div key={artifact.id} className="flex items-start gap-2 text-sm">
            <GlobeIcon className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1">
                <a
                  href={artifact.url!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline truncate"
                  title={artifact.url!}
                >
                  {label}
                </a>
                {statusBadge(artifact.metadata?.previewStatus)}
              </div>
              {repo && <span className="text-xs text-muted-foreground">{repo}</span>}
            </div>
          </div>
        );
      })}

      {/* code-server block */}
      {(codeServerArtifact || codeServer) && (
        <div className="flex items-start gap-2 text-sm">
          <GlobeIcon className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1 space-y-1">
            {/* URL */}
            {(codeServerArtifact?.url ?? codeServer?.url) && (
              <a
                href={codeServerArtifact?.url ?? codeServer!.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline truncate block"
                title={codeServerArtifact?.url ?? codeServer?.url}
              >
                code-server
              </a>
            )}

            {/* Password (from in-memory WS state only) */}
            {codeServer?.password && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <KeyIcon className="w-3 h-3 shrink-0" />
                <span className="font-mono select-all">{codeServer.password}</span>
                <button
                  onClick={() => handleCopy(codeServer.password, "password")}
                  className="p-0.5 hover:bg-muted transition-colors"
                  title={copiedLabel === "password" ? "Copied!" : "Copy password"}
                >
                  {copiedLabel === "password" ? (
                    <CheckIcon className="w-3 h-3 text-success" />
                  ) : (
                    <CopyIcon className="w-3 h-3" />
                  )}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
