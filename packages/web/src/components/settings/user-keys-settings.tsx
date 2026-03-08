"use client";

import { useCallback, useEffect, useMemo, useState, type ClipboardEvent } from "react";
import useSWR, { mutate } from "swr";

import { normalizeKey, parseMaybeEnvContent, type ParsedEnvEntry } from "@/lib/env-paste";

const VALID_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_KEY_LENGTH = 256;
const MAX_VALUE_SIZE = 16384;
const MAX_TOTAL_VALUE_SIZE = 65536;
const MAX_SECRETS_PER_SCOPE = 50;

const RESERVED_KEYS = new Set([
  "PYTHONUNBUFFERED",
  "SANDBOX_ID",
  "CONTROL_PLANE_URL",
  "SANDBOX_AUTH_TOKEN",
  "REPO_OWNER",
  "REPO_NAME",
  "GITHUB_APP_TOKEN",
  "SESSION_CONFIG",
  "RESTORED_FROM_SNAPSHOT",
  "OPENCODE_CONFIG_CONTENT",
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TERM",
  "PWD",
  "LANG",
]);

const QUICK_ADD_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"];

type SecretRow = {
  id: string;
  key: string;
  value: string;
  existing: boolean;
};

function validateKey(value: string): string | null {
  if (!value) return "Key is required";
  if (value.length > MAX_KEY_LENGTH) return "Key is too long";
  if (!VALID_KEY_PATTERN.test(value)) return "Key must match [A-Za-z_][A-Za-z0-9_]*";
  if (RESERVED_KEYS.has(value.toUpperCase())) return `Key '${value}' is reserved`;
  return null;
}

function getUtf8Size(value: string): number {
  return new TextEncoder().encode(value).length;
}

function createRow(partial?: Partial<SecretRow>): SecretRow {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return {
    id,
    key: "",
    value: "",
    existing: false,
    ...partial,
  };
}

const API_BASE = "/api/user/secrets";

export function UserKeysSettings() {
  const [rows, setRows] = useState<SecretRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  const {
    data: secretsData,
    isLoading: loading,
    error: fetchError,
  } = useSWR<{ secrets: { key: string }[] }>(API_BASE);

  // Sync SWR data into local editable rows
  const secrets = secretsData?.secrets;
  useEffect(() => {
    if (!Array.isArray(secrets)) {
      setRows([]);
      return;
    }
    setRows(
      secrets.map((secret: { key: string }) =>
        createRow({ key: secret.key, value: "", existing: true })
      )
    );
  }, [secrets]);

  // Show fetch errors to the user
  useEffect(() => {
    if (fetchError) {
      setError("Failed to load API keys");
    }
  }, [fetchError]);

  const existingKeySet = useMemo(() => {
    return new Set(rows.filter((row) => row.existing).map((row) => normalizeKey(row.key)));
  }, [rows]);

  const applyEnvEntries = useCallback((entries: ParsedEnvEntry[]) => {
    setRows((current) => {
      const next = [...current];
      const keyToIndex = new Map<string, number>();

      next.forEach((row, index) => {
        const normalized = normalizeKey(row.key);
        if (normalized) {
          keyToIndex.set(normalized, index);
        }
      });

      for (const entry of entries) {
        const normalizedKey = normalizeKey(entry.key);
        const existingIndex = keyToIndex.get(normalizedKey);

        if (existingIndex !== undefined) {
          next[existingIndex] = {
            ...next[existingIndex],
            key: normalizedKey,
            value: entry.value,
          };
          continue;
        }

        const emptyRowIndex = next.findIndex(
          (row) => !row.existing && row.key.trim() === "" && row.value.trim() === ""
        );

        if (emptyRowIndex >= 0) {
          next[emptyRowIndex] = {
            ...next[emptyRowIndex],
            key: normalizedKey,
            value: entry.value,
          };
          keyToIndex.set(normalizedKey, emptyRowIndex);
          continue;
        }

        next.push(createRow({ key: normalizedKey, value: entry.value }));
        keyToIndex.set(normalizedKey, next.length - 1);
      }

      return next;
    });
  }, []);

  const handlePasteIntoRow = useCallback(
    (event: ClipboardEvent<HTMLInputElement>) => {
      const pastedText = event.clipboardData.getData("text");
      const parsed = parseMaybeEnvContent(pastedText);
      if (parsed.length === 0) {
        return;
      }

      const valid = parsed.filter((entry) => !RESERVED_KEYS.has(entry.key));
      const skipped = parsed.length - valid.length;

      if (valid.length === 0 && skipped > 0) {
        event.preventDefault();
        setError(`All ${skipped} pasted key${skipped === 1 ? " is" : "s are"} reserved`);
        return;
      }

      event.preventDefault();
      applyEnvEntries(valid);
      setError("");

      const imported = `Imported ${valid.length} secret${valid.length === 1 ? "" : "s"} from paste`;
      const skippedMsg = skipped > 0 ? ` (skipped ${skipped} reserved)` : "";
      setSuccess(imported + skippedMsg);
    },
    [applyEnvEntries]
  );

  const handleAddRow = () => {
    setRows((current) => [...current, createRow()]);
  };

  const handleQuickAdd = (keyName: string) => {
    // Check if key already exists in rows
    const normalized = normalizeKey(keyName);
    const alreadyExists = rows.some((row) => normalizeKey(row.key) === normalized);
    if (alreadyExists) {
      setError(`${normalized} already exists`);
      return;
    }
    setRows((current) => [...current, createRow({ key: normalized })]);
    setError("");
  };

  const handleDeleteRow = async (row: SecretRow) => {
    if (!row.existing || !row.key) {
      setRows((current) => current.filter((item) => item.id !== row.id));
      return;
    }

    const normalizedKey = normalizeKey(row.key);
    setDeletingKey(normalizedKey);
    setError("");
    setSuccess("");

    try {
      const response = await fetch(`${API_BASE}/${encodeURIComponent(normalizedKey)}`, {
        method: "DELETE",
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data?.error || "Failed to delete key");
        return;
      }
      setSuccess(`Deleted ${normalizedKey}`);
      mutate(API_BASE);
    } catch {
      setError("Failed to delete key");
    } finally {
      setDeletingKey(null);
    }
  };

  const handleSave = async () => {
    setError("");
    setSuccess("");

    const entries = rows
      .filter((row) => row.value.trim().length > 0)
      .map((row) => ({
        key: normalizeKey(row.key),
        value: row.value,
        existing: row.existing,
      }));

    if (entries.length === 0) {
      setSuccess("No changes to save");
      return;
    }

    const uniqueKeys = new Set<string>();
    let totalSize = 0;

    for (const entry of entries) {
      const keyError = validateKey(entry.key);
      if (keyError) {
        setError(keyError);
        return;
      }
      if (uniqueKeys.has(entry.key)) {
        setError(`Duplicate key '${entry.key}'`);
        return;
      }
      uniqueKeys.add(entry.key);

      const valueSize = getUtf8Size(entry.value);
      if (valueSize > MAX_VALUE_SIZE) {
        setError(`Value for '${entry.key}' exceeds ${MAX_VALUE_SIZE} bytes`);
        return;
      }
      totalSize += valueSize;
    }

    if (totalSize > MAX_TOTAL_VALUE_SIZE) {
      setError(`Total secret size exceeds ${MAX_TOTAL_VALUE_SIZE} bytes`);
      return;
    }

    const netNew = entries.filter((entry) => !existingKeySet.has(entry.key)).length;
    if (existingKeySet.size + netNew > MAX_SECRETS_PER_SCOPE) {
      setError(`Would exceed ${MAX_SECRETS_PER_SCOPE} keys limit`);
      return;
    }

    const hasIncompleteNewRow = rows.some(
      (row) => !row.existing && row.key.trim().length > 0 && row.value.trim().length === 0
    );
    if (hasIncompleteNewRow) {
      setError("Enter a value for new keys or remove the empty row");
      return;
    }

    setSaving(true);

    try {
      const payload: Record<string, string> = {};
      for (const entry of entries) {
        payload[entry.key] = entry.value;
      }

      const response = await fetch(API_BASE, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets: payload }),
      });
      const data = await response.json();

      if (!response.ok) {
        setError(data?.error || "Failed to update keys");
        return;
      }

      setSuccess("API keys updated");
      mutate(API_BASE);
    } catch {
      setError("Failed to update keys");
    } finally {
      setSaving(false);
    }
  };

  // Quick add buttons: only show for keys not already present
  const availableQuickAddKeys = QUICK_ADD_KEYS.filter(
    (k) => !rows.some((row) => normalizeKey(row.key) === k)
  );

  return (
    <div>
      <h2 className="text-xl font-semibold text-foreground mb-1">API Keys</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Your API keys are used when you start a session. They override the shared deployment keys
        but can be overridden by repository-level secrets.
      </p>

      {/* Quick Add */}
      {availableQuickAddKeys.length > 0 && (
        <div className="mb-4">
          <label className="block text-sm font-medium text-foreground mb-1.5">Quick Add</label>
          <div className="flex flex-wrap gap-2">
            {availableQuickAddKeys.map((keyName) => (
              <button
                key={keyName}
                type="button"
                onClick={() => handleQuickAdd(keyName)}
                className="text-xs px-3 py-1.5 border border-border-muted text-muted-foreground hover:text-foreground hover:border-border transition"
              >
                + {keyName}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4 border border-border bg-background p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Keys</h3>
            <p className="text-xs text-muted-foreground">
              Values are never shown after save. Keys are injected as environment variables.
            </p>
          </div>
          <button
            type="button"
            onClick={handleAddRow}
            className="text-xs px-2 py-1 border border-border-muted text-muted-foreground hover:text-foreground hover:border-border transition"
          >
            Add key
          </button>
        </div>

        {loading && <p className="text-xs text-muted-foreground">Loading keys...</p>}

        {!loading && rows.length === 0 && (
          <p className="text-xs text-muted-foreground">No API keys set.</p>
        )}

        <div className="space-y-2">
          {rows.map((row) => (
            <div key={row.id} className="flex flex-col gap-2 border border-border-muted p-2">
              <div className="flex flex-wrap gap-2">
                <input
                  type="text"
                  value={row.key}
                  onChange={(e) => {
                    const keyValue = e.target.value;
                    setRows((current) =>
                      current.map((item) =>
                        item.id === row.id ? { ...item, key: keyValue } : item
                      )
                    );
                  }}
                  onBlur={(e) => {
                    const normalized = normalizeKey(e.target.value);
                    setRows((current) =>
                      current.map((item) =>
                        item.id === row.id ? { ...item, key: normalized } : item
                      )
                    );
                  }}
                  placeholder="KEY_NAME"
                  disabled={row.existing}
                  onPaste={handlePasteIntoRow}
                  className="flex-1 min-w-[160px] bg-input border border-border px-2 py-1 text-xs text-foreground disabled:opacity-60"
                />
                <input
                  type="password"
                  value={row.value}
                  onChange={(e) => {
                    const val = e.target.value;
                    setRows((current) =>
                      current.map((item) => (item.id === row.id ? { ...item, value: val } : item))
                    );
                  }}
                  placeholder={row.existing ? "••••••••" : "value"}
                  onPaste={handlePasteIntoRow}
                  className="flex-1 min-w-[200px] bg-input border border-border px-2 py-1 text-xs text-foreground disabled:opacity-60"
                />
                <button
                  type="button"
                  onClick={() => handleDeleteRow(row)}
                  disabled={deletingKey === normalizeKey(row.key)}
                  className="text-xs px-2 py-1 border border-border-muted text-muted-foreground hover:text-red-500 hover:border-red-300 transition disabled:opacity-50"
                >
                  {deletingKey === normalizeKey(row.key) ? "Deleting..." : "Delete"}
                </button>
              </div>
              {row.existing && (
                <p className="text-[11px] text-muted-foreground">
                  To update, enter a new value and save.
                </p>
              )}
            </div>
          ))}
        </div>

        {error && <p className="mt-3 text-xs text-red-500">{error}</p>}
        {success && <p className="mt-3 text-xs text-green-600">{success}</p>}

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="text-xs px-3 py-1 border border-border-muted text-foreground hover:border-foreground transition disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save keys"}
          </button>
          <span className="text-[11px] text-muted-foreground">
            Keys are automatically uppercased. Paste a `.env` block into either field to import.
          </span>
        </div>
      </div>
    </div>
  );
}
