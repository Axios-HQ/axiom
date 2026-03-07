"use client";

import { useState, useRef, useEffect, useCallback } from "react";

interface SessionRenameProps {
  sessionId: string;
  currentTitle: string;
  isEditing: boolean;
  onStartEdit: () => void;
  onFinishEdit: () => void;
  onRename: (sessionId: string, newTitle: string) => Promise<void>;
}

export function SessionRename({
  sessionId,
  currentTitle,
  isEditing,
  onStartEdit,
  onFinishEdit,
  onRename,
}: SessionRenameProps) {
  const [editValue, setEditValue] = useState(currentTitle);
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);

  useEffect(() => {
    if (isEditing) {
      setEditValue(currentTitle);
      // Focus after render
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [isEditing, currentTitle]);

  const handleSave = useCallback(async () => {
    // Prevent double-save from Enter + blur
    if (savingRef.current) return;
    savingRef.current = true;

    const trimmed = editValue.trim();
    if (!trimmed || trimmed === currentTitle) {
      savingRef.current = false;
      onFinishEdit();
      return;
    }

    setIsSaving(true);
    try {
      await onRename(sessionId, trimmed);
    } finally {
      setIsSaving(false);
      savingRef.current = false;
      onFinishEdit();
    }
  }, [editValue, currentTitle, sessionId, onRename, onFinishEdit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSave();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onFinishEdit();
      }
    },
    [handleSave, onFinishEdit]
  );

  if (!isEditing) {
    return (
      <span
        className="truncate text-sm font-medium text-foreground"
        onDoubleClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onStartEdit();
        }}
      >
        {currentTitle}
      </span>
    );
  }

  return (
    <input
      ref={inputRef}
      type="text"
      value={editValue}
      onChange={(e) => setEditValue(e.target.value)}
      onBlur={handleSave}
      onKeyDown={handleKeyDown}
      disabled={isSaving}
      className="w-full text-sm font-medium text-foreground bg-input border border-border px-1 py-0 focus:outline-none focus:ring-1 focus:ring-ring"
      aria-label="Rename session"
    />
  );
}
