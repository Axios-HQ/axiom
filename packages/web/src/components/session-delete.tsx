"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { ArchiveIcon } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";

interface SessionDeleteProps {
  sessionId: string;
  onDelete: (sessionId: string) => Promise<void>;
}

export function SessionDelete({ sessionId, onDelete }: SessionDeleteProps) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);

  const handleDelete = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDeleting(true);
      try {
        await onDelete(sessionId);
      } finally {
        setIsDeleting(false);
        setShowConfirm(false);
      }
    },
    [sessionId, onDelete]
  );

  const handleClickDelete = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setShowConfirm(true);
  }, []);

  const handleCancel = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setShowConfirm(false);
  }, []);

  // Close confirm dialog on click outside
  useEffect(() => {
    if (!showConfirm) return;

    function handleClickOutside(event: MouseEvent) {
      if (confirmRef.current && !confirmRef.current.contains(event.target as Node)) {
        setShowConfirm(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showConfirm]);

  if (showConfirm) {
    return (
      <div
        ref={confirmRef}
        className="absolute right-2 top-1 z-10 flex items-center gap-1 bg-background border border-border rounded-md px-2 py-1 shadow-md"
        role="dialog"
        aria-label="Confirm delete"
      >
        <span className="text-xs text-muted-foreground whitespace-nowrap">Delete?</span>
        <Button
          variant="destructive"
          size="xs"
          onClick={handleDelete}
          disabled={isDeleting}
          aria-label="Confirm delete session"
        >
          {isDeleting ? "..." : "Yes"}
        </Button>
        <Button variant="ghost" size="xs" onClick={handleCancel} aria-label="Cancel delete">
          No
        </Button>
      </div>
    );
  }

  return (
    <button
      onClick={handleClickDelete}
      className="p-0.5 text-muted-foreground hover:text-red-500 transition-colors"
      title="Archive session"
      aria-label="Delete session"
    >
      <ArchiveIcon className="w-3.5 h-3.5" />
    </button>
  );
}
