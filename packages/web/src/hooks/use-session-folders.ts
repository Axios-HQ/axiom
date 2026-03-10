"use client";

import { useState, useCallback, useEffect } from "react";

const STORAGE_KEY = "session-folders";

export interface SessionFolder {
  id: string;
  name: string;
  sessionIds: string[];
}

export interface SessionFoldersState {
  folders: SessionFolder[];
}

function generateId(): string {
  return `folder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadState(): SessionFoldersState {
  if (typeof window === "undefined") {
    return { folders: [] };
  }
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored) as SessionFoldersState;
    }
  } catch {
    // Corrupted storage — start fresh
  }
  return { folders: [] };
}

function saveState(state: SessionFoldersState): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full or unavailable
  }
}

export function useSessionFolders() {
  const [state, setState] = useState<SessionFoldersState>(() => loadState());

  // Sync to localStorage on changes
  useEffect(() => {
    saveState(state);
  }, [state]);

  const createFolder = useCallback((name: string): string => {
    const id = generateId();
    setState((prev) => ({
      folders: [...prev.folders, { id, name, sessionIds: [] }],
    }));
    return id;
  }, []);

  const renameFolder = useCallback((folderId: string, name: string) => {
    setState((prev) => ({
      folders: prev.folders.map((f) => (f.id === folderId ? { ...f, name } : f)),
    }));
  }, []);

  const deleteFolder = useCallback((folderId: string) => {
    setState((prev) => ({
      folders: prev.folders.filter((f) => f.id !== folderId),
    }));
  }, []);

  const addSessionToFolder = useCallback((folderId: string, sessionId: string) => {
    setState((prev) => ({
      folders: prev.folders.map((f) => {
        if (f.id === folderId) {
          if (f.sessionIds.includes(sessionId)) return f;
          return { ...f, sessionIds: [...f.sessionIds, sessionId] };
        }
        // Remove from other folders
        return {
          ...f,
          sessionIds: f.sessionIds.filter((id) => id !== sessionId),
        };
      }),
    }));
  }, []);

  const removeSessionFromFolder = useCallback((sessionId: string) => {
    setState((prev) => ({
      folders: prev.folders.map((f) => ({
        ...f,
        sessionIds: f.sessionIds.filter((id) => id !== sessionId),
      })),
    }));
  }, []);

  const getFolderForSession = useCallback(
    (sessionId: string): SessionFolder | undefined => {
      return state.folders.find((f) => f.sessionIds.includes(sessionId));
    },
    [state.folders]
  );

  return {
    folders: state.folders,
    createFolder,
    renameFolder,
    deleteFolder,
    addSessionToFolder,
    removeSessionFromFolder,
    getFolderForSession,
  };
}
