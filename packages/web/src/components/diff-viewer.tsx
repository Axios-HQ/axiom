"use client";

import { useState, useMemo } from "react";
import { ChevronDownIcon, ChevronRightIcon, FileIcon } from "@/components/ui/icons";

/** A single line within a parsed diff hunk. */
interface DiffLine {
  type: "addition" | "deletion" | "context";
  content: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

/** A parsed hunk with its header and lines. */
interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

/** A parsed file section within a unified diff. */
interface DiffFile {
  oldPath: string;
  newPath: string;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

/**
 * Parse a unified diff string into structured file sections.
 *
 * Handles standard unified diff format with `---`/`+++` file headers
 * and `@@` hunk headers.
 */
export function parseUnifiedDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = diffText.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Look for file header: --- a/path
    if (line.startsWith("---")) {
      const oldPath = extractPath(line, "--- ");
      const nextLine = lines[i + 1];
      if (!nextLine?.startsWith("+++")) {
        i++;
        continue;
      }
      const newPath = extractPath(nextLine, "+++ ");
      i += 2;

      const hunks: DiffHunk[] = [];
      let fileAdditions = 0;
      let fileDeletions = 0;

      // Parse hunks for this file
      while (i < lines.length && !lines[i].startsWith("---") && !lines[i].startsWith("diff --git")) {
        if (lines[i].startsWith("@@")) {
          const hunkHeader = lines[i];
          const { oldStart, newStart } = parseHunkHeader(hunkHeader);
          i++;

          const hunkLines: DiffLine[] = [];
          let oldLine = oldStart;
          let newLine = newStart;

          while (
            i < lines.length &&
            !lines[i].startsWith("@@") &&
            !lines[i].startsWith("---") &&
            !lines[i].startsWith("diff --git")
          ) {
            const hunkLine = lines[i];

            if (hunkLine.startsWith("+")) {
              hunkLines.push({
                type: "addition",
                content: hunkLine.slice(1),
                oldLineNumber: null,
                newLineNumber: newLine,
              });
              newLine++;
              fileAdditions++;
            } else if (hunkLine.startsWith("-")) {
              hunkLines.push({
                type: "deletion",
                content: hunkLine.slice(1),
                oldLineNumber: oldLine,
                newLineNumber: null,
              });
              oldLine++;
              fileDeletions++;
            } else if (hunkLine.startsWith(" ") || hunkLine === "") {
              hunkLines.push({
                type: "context",
                content: hunkLine.startsWith(" ") ? hunkLine.slice(1) : hunkLine,
                oldLineNumber: oldLine,
                newLineNumber: newLine,
              });
              oldLine++;
              newLine++;
            } else if (hunkLine.startsWith("\\")) {
              // "\ No newline at end of file" — skip
            } else {
              // Unknown line format, stop parsing this hunk
              break;
            }
            i++;
          }

          hunks.push({ header: hunkHeader, lines: hunkLines });
        } else {
          i++;
        }
      }

      files.push({
        oldPath,
        newPath,
        hunks,
        additions: fileAdditions,
        deletions: fileDeletions,
      });
    } else {
      i++;
    }
  }

  return files;
}

function extractPath(line: string, prefix: string): string {
  let path = line.slice(prefix.length).trim();
  // Remove a/ or b/ prefix
  if (path.startsWith("a/") || path.startsWith("b/")) {
    path = path.slice(2);
  }
  // Handle /dev/null for new/deleted files
  if (path === "/dev/null") {
    return "/dev/null";
  }
  return path;
}

function parseHunkHeader(header: string): { oldStart: number; newStart: number } {
  const match = header.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!match) return { oldStart: 1, newStart: 1 };
  return { oldStart: parseInt(match[1], 10), newStart: parseInt(match[2], 10) };
}

interface DiffViewerProps {
  /** A unified diff string to parse and display. */
  diff: string;
  /** Maximum number of lines to render per file before truncating. Defaults to 2000. */
  maxLinesPerFile?: number;
}

/**
 * Displays a unified diff with syntax highlighting, line numbers,
 * and collapsible file sections.
 */
export function DiffViewer({ diff, maxLinesPerFile = 2000 }: DiffViewerProps) {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);

  if (files.length === 0) {
    return (
      <div className="text-sm text-muted-foreground px-4 py-3">
        No changes to display.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {files.map((file, idx) => (
        <DiffFileSection key={`${file.newPath}-${idx}`} file={file} maxLines={maxLinesPerFile} />
      ))}
    </div>
  );
}

function DiffFileSection({ file, maxLines }: { file: DiffFile; maxLines: number }) {
  const [collapsed, setCollapsed] = useState(false);

  const displayPath = file.newPath === "/dev/null" ? file.oldPath : file.newPath;
  const isNewFile = file.oldPath === "/dev/null";
  const isDeletedFile = file.newPath === "/dev/null";

  const totalLines = file.hunks.reduce((sum, h) => sum + h.lines.length, 0);
  const isTruncated = totalLines > maxLines;

  return (
    <div className="border border-border overflow-hidden" data-testid="diff-file">
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm bg-muted hover:bg-muted/80 transition text-left"
        aria-expanded={!collapsed}
      >
        {collapsed ? (
          <ChevronRightIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        ) : (
          <ChevronDownIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        )}
        <FileIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        <span className="font-mono text-foreground truncate">{displayPath}</span>
        {isNewFile && (
          <span className="text-xs px-1.5 py-0.5 bg-green-500/10 text-green-600 font-medium">
            new
          </span>
        )}
        {isDeletedFile && (
          <span className="text-xs px-1.5 py-0.5 bg-red-500/10 text-red-600 font-medium">
            deleted
          </span>
        )}
        <span className="ml-auto flex items-center gap-2 text-xs font-mono flex-shrink-0">
          {file.additions > 0 && (
            <span className="text-green-600">+{file.additions}</span>
          )}
          {file.deletions > 0 && (
            <span className="text-red-600">-{file.deletions}</span>
          )}
        </span>
      </button>

      {!collapsed && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono border-collapse">
            <tbody>
              {file.hunks.map((hunk, hunkIdx) => {
                const linesToRender = isTruncated
                  ? hunk.lines.slice(0, Math.max(0, maxLines - countPreviousLines(file.hunks, hunkIdx)))
                  : hunk.lines;

                if (linesToRender.length === 0) return null;

                return (
                  <HunkSection key={hunkIdx} hunk={{ ...hunk, lines: linesToRender }} hunkHeader={hunk.header} />
                );
              })}
              {isTruncated && (
                <tr>
                  <td colSpan={3} className="px-4 py-2 text-center text-muted-foreground bg-muted text-xs">
                    Diff truncated ({totalLines} lines total, showing first {maxLines})
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function countPreviousLines(hunks: DiffHunk[], beforeIndex: number): number {
  let count = 0;
  for (let i = 0; i < beforeIndex; i++) {
    count += hunks[i].lines.length;
  }
  return count;
}

function HunkSection({ hunk, hunkHeader }: { hunk: DiffHunk; hunkHeader: string }) {
  return (
    <>
      <tr>
        <td
          colSpan={3}
          className="px-4 py-1 text-xs text-secondary-foreground bg-muted border-t border-border-muted font-mono"
        >
          {hunkHeader}
        </td>
      </tr>
      {hunk.lines.map((line, lineIdx) => (
        <DiffLineRow key={lineIdx} line={line} />
      ))}
    </>
  );
}

function DiffLineRow({ line }: { line: DiffLine }) {
  const bgClass =
    line.type === "addition"
      ? "bg-green-500/10"
      : line.type === "deletion"
        ? "bg-red-500/10"
        : "";

  const textClass =
    line.type === "addition"
      ? "text-green-700 dark:text-green-400"
      : line.type === "deletion"
        ? "text-red-700 dark:text-red-400"
        : "text-foreground";

  const prefix =
    line.type === "addition" ? "+" : line.type === "deletion" ? "-" : " ";

  return (
    <tr className={bgClass} data-testid={`diff-line-${line.type}`}>
      <td className="px-2 py-0 text-right text-muted-foreground select-none w-12 align-top border-r border-border-muted">
        {line.oldLineNumber ?? ""}
      </td>
      <td className="px-2 py-0 text-right text-muted-foreground select-none w-12 align-top border-r border-border-muted">
        {line.newLineNumber ?? ""}
      </td>
      <td className={`px-3 py-0 whitespace-pre ${textClass}`}>
        <span className="select-none">{prefix}</span>
        {line.content}
      </td>
    </tr>
  );
}
