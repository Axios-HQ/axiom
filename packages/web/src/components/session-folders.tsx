"use client";

import { useState, useCallback } from "react";
import { FolderIcon, PlusIcon, PencilIcon } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import type { SessionFolder } from "@/hooks/use-session-folders";

interface SessionFolderListProps {
  folders: SessionFolder[];
  expandedFolderIds: Set<string>;
  onToggleFolder: (folderId: string) => void;
  onCreateFolder: (name: string) => void;
  onRenameFolder: (folderId: string, name: string) => void;
  onDeleteFolder: (folderId: string) => void;
  onDropSession: (folderId: string, sessionId: string) => void;
  renderFolderContent: (folder: SessionFolder) => React.ReactNode;
}

export function SessionFolderList({
  folders,
  expandedFolderIds,
  onToggleFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onDropSession,
  renderFolderContent,
}: SessionFolderListProps) {
  const [isCreating, setIsCreating] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  const handleCreateSubmit = useCallback(() => {
    const name = newFolderName.trim();
    if (name) {
      onCreateFolder(name);
    }
    setNewFolderName("");
    setIsCreating(false);
  }, [newFolderName, onCreateFolder]);

  return (
    <div className="flex flex-col">
      {/* Folder header */}
      <div className="flex items-center justify-between px-4 py-1.5">
        <span className="text-xs font-medium text-secondary-foreground uppercase tracking-wide">
          Folders
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setIsCreating(true)}
          title="Create folder"
          aria-label="Create folder"
          className="!p-0.5"
        >
          <PlusIcon className="w-3 h-3" />
        </Button>
      </div>

      {/* New folder input */}
      {isCreating && (
        <div className="px-4 py-1">
          <input
            type="text"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onBlur={handleCreateSubmit}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreateSubmit();
              if (e.key === "Escape") {
                setNewFolderName("");
                setIsCreating(false);
              }
            }}
            autoFocus
            placeholder="Folder name..."
            className="w-full text-xs bg-input border border-border px-2 py-1 focus:outline-none focus:ring-1 focus:ring-ring text-foreground placeholder:text-secondary-foreground"
            aria-label="New folder name"
          />
        </div>
      )}

      {/* Folder items */}
      {folders.map((folder) => (
        <FolderItem
          key={folder.id}
          folder={folder}
          isExpanded={expandedFolderIds.has(folder.id)}
          onToggle={() => onToggleFolder(folder.id)}
          onRename={(name) => onRenameFolder(folder.id, name)}
          onDelete={() => onDeleteFolder(folder.id)}
          onDropSession={(sessionId) => onDropSession(folder.id, sessionId)}
        >
          {renderFolderContent(folder)}
        </FolderItem>
      ))}
    </div>
  );
}

interface FolderItemProps {
  folder: SessionFolder;
  isExpanded: boolean;
  onToggle: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onDropSession: (sessionId: string) => void;
  children: React.ReactNode;
}

function FolderItem({
  folder,
  isExpanded,
  onToggle,
  onRename,
  onDelete,
  onDropSession,
  children,
}: FolderItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(folder.name);
  const [isDragOver, setIsDragOver] = useState(false);

  const handleRenameSubmit = useCallback(() => {
    const name = editName.trim();
    if (name && name !== folder.name) {
      onRename(name);
    }
    setIsEditing(false);
  }, [editName, folder.name, onRename]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const sessionId = e.dataTransfer.getData("text/session-id");
      if (sessionId) {
        onDropSession(sessionId);
      }
    },
    [onDropSession]
  );

  return (
    <div>
      <div
        className={`flex items-center gap-1.5 px-4 py-1.5 cursor-pointer transition ${
          isDragOver
            ? "bg-accent-muted border-l-2 border-l-accent"
            : "hover:bg-muted border-l-2 border-l-transparent"
        }`}
        onClick={onToggle}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        role="button"
        aria-expanded={isExpanded}
        aria-label={`Folder: ${folder.name}`}
      >
        <FolderIcon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        {isEditing ? (
          <input
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={handleRenameSubmit}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRenameSubmit();
              if (e.key === "Escape") setIsEditing(false);
            }}
            onClick={(e) => e.stopPropagation()}
            autoFocus
            className="flex-1 text-xs bg-input border border-border px-1 py-0 focus:outline-none focus:ring-1 focus:ring-ring text-foreground"
            aria-label="Rename folder"
          />
        ) : (
          <span className="flex-1 text-xs font-medium text-foreground truncate">{folder.name}</span>
        )}
        <span className="text-xs text-muted-foreground">{folder.sessionIds.length}</span>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setEditName(folder.name);
              setIsEditing(true);
            }}
            className="p-0.5 text-muted-foreground hover:text-foreground"
            title="Rename folder"
            aria-label="Rename folder"
          >
            <PencilIcon className="w-3 h-3" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="p-0.5 text-muted-foreground hover:text-red-500"
            title="Delete folder"
            aria-label="Delete folder"
          >
            <span className="text-xs">x</span>
          </button>
        </div>
      </div>
      {isExpanded && <div className="pl-2">{children}</div>}
    </div>
  );
}

/**
 * Make a session item draggable for folder drag-and-drop.
 * Wrap session list items with this to enable drag.
 */
export function DraggableSession({
  sessionId,
  children,
}: {
  sessionId: string;
  children: React.ReactNode;
}) {
  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      e.dataTransfer.setData("text/session-id", sessionId);
      e.dataTransfer.effectAllowed = "move";
    },
    [sessionId]
  );

  return (
    <div draggable onDragStart={handleDragStart}>
      {children}
    </div>
  );
}
