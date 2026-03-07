"use client";

import { useState, useEffect, useCallback, useRef, useId } from "react";

export interface SlashCommand {
  /** The command name without the leading slash (e.g. "model"). */
  name: string;
  /** Short label shown in the menu. */
  label: string;
  /** Description shown below the label. */
  description: string;
  /** Callback invoked when the command is selected. */
  action: () => void;
}

interface SlashCommandMenuProps {
  /** The current input value from the chat input field. */
  inputValue: string;
  /** List of available slash commands. */
  commands: SlashCommand[];
  /** Called when a command is selected, to allow the parent to clear the input. */
  onCommandSelect: (command: SlashCommand) => void;
  /** Called when the menu should be dismissed without selecting. */
  onDismiss: () => void;
}

/**
 * A floating command menu that appears when the user types `/` at the start
 * of the chat input. Filters commands as the user types and supports
 * keyboard navigation (arrow keys, Enter, Escape).
 */
export function SlashCommandMenu({
  inputValue,
  commands,
  onCommandSelect,
  onDismiss,
}: SlashCommandMenuProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const instanceId = useId();

  // Determine if the menu should be visible and what filter to apply
  const isSlashCommand = inputValue.startsWith("/");
  const filterQuery = isSlashCommand ? inputValue.slice(1).toLowerCase() : "";

  const filteredCommands = isSlashCommand
    ? commands.filter(
        (cmd) =>
          cmd.name.toLowerCase().startsWith(filterQuery) ||
          cmd.label.toLowerCase().startsWith(filterQuery)
      )
    : [];

  const isVisible = isSlashCommand && filteredCommands.length > 0;

  // Reset active index when filter changes
  useEffect(() => {
    setActiveIndex(0);
  }, [filterQuery]);

  // Scroll active item into view
  useEffect(() => {
    if (!listRef.current || activeIndex < 0) return;
    const activeEl = listRef.current.querySelector(`[data-command-index="${activeIndex}"]`);
    if (activeEl && typeof activeEl.scrollIntoView === "function") {
      activeEl.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

  const selectCommand = useCallback(
    (command: SlashCommand) => {
      command.action();
      onCommandSelect(command);
    },
    [onCommandSelect]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isVisible) return;

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          setActiveIndex((prev) => (prev + 1) % filteredCommands.length);
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          setActiveIndex((prev) =>
            prev <= 0 ? filteredCommands.length - 1 : prev - 1
          );
          break;
        }
        case "Enter": {
          e.preventDefault();
          if (activeIndex >= 0 && activeIndex < filteredCommands.length) {
            selectCommand(filteredCommands[activeIndex]);
          }
          break;
        }
        case "Escape": {
          e.preventDefault();
          onDismiss();
          break;
        }
        case "Tab": {
          e.preventDefault();
          if (activeIndex >= 0 && activeIndex < filteredCommands.length) {
            selectCommand(filteredCommands[activeIndex]);
          }
          break;
        }
      }
    },
    [isVisible, filteredCommands, activeIndex, selectCommand, onDismiss]
  );

  // Attach keyboard listener
  useEffect(() => {
    if (!isVisible) return;
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isVisible, handleKeyDown]);

  if (!isVisible) return null;

  return (
    <div
      className="absolute bottom-full mb-2 left-0 w-64 bg-background border border-border shadow-lg z-50"
      role="listbox"
      id={`${instanceId}-slash-menu`}
      data-testid="slash-command-menu"
    >
      <div ref={listRef} className="max-h-48 overflow-y-auto py-1">
        {filteredCommands.map((command, idx) => (
          <button
            key={command.name}
            type="button"
            role="option"
            aria-selected={idx === activeIndex}
            data-command-index={idx}
            onClick={() => selectCommand(command)}
            onMouseEnter={() => setActiveIndex(idx)}
            className={`w-full flex flex-col items-start px-3 py-2 text-sm transition text-left ${
              idx === activeIndex ? "bg-muted" : ""
            }`}
          >
            <span className="font-medium text-foreground font-mono">
              /{command.name}
            </span>
            <span className="text-xs text-muted-foreground">{command.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Default slash commands for the chat input.
 * Actions are provided as no-ops here; consumers should override them.
 */
export const DEFAULT_SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "model",
    label: "Model",
    description: "Show model selector",
    action: () => {},
  },
  {
    name: "branch",
    label: "Branch",
    description: "Show branch selector",
    action: () => {},
  },
  {
    name: "stop",
    label: "Stop",
    description: "Stop the current agent",
    action: () => {},
  },
  {
    name: "archive",
    label: "Archive",
    description: "Archive the session",
    action: () => {},
  },
];
