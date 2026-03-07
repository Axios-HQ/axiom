// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { DiffViewer, parseUnifiedDiff } from "./diff-viewer";

afterEach(() => {
  cleanup();
});

const SIMPLE_DIFF = `diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,5 +1,6 @@
 import { foo } from "bar";

-const x = 1;
+const x = 2;
+const y = 3;

 export { foo };
`;

const MULTI_FILE_DIFF = `diff --git a/file1.ts b/file1.ts
--- a/file1.ts
+++ b/file1.ts
@@ -1,3 +1,3 @@
 line1
-line2
+line2modified
 line3
diff --git a/file2.ts b/file2.ts
--- a/file2.ts
+++ b/file2.ts
@@ -1,2 +1,3 @@
 hello
+world
 end
`;

const NEW_FILE_DIFF = `diff --git a/newfile.ts b/newfile.ts
--- /dev/null
+++ b/newfile.ts
@@ -0,0 +1,3 @@
+line1
+line2
+line3
`;

const DELETED_FILE_DIFF = `diff --git a/oldfile.ts b/oldfile.ts
--- a/oldfile.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-line1
-line2
`;

describe("parseUnifiedDiff", () => {
  it("parses a simple diff with additions and deletions", () => {
    const files = parseUnifiedDiff(SIMPLE_DIFF);
    expect(files).toHaveLength(1);
    expect(files[0].oldPath).toBe("src/index.ts");
    expect(files[0].newPath).toBe("src/index.ts");
    expect(files[0].additions).toBe(2);
    expect(files[0].deletions).toBe(1);
    expect(files[0].hunks).toHaveLength(1);
  });

  it("parses multiple files", () => {
    const files = parseUnifiedDiff(MULTI_FILE_DIFF);
    expect(files).toHaveLength(2);
    expect(files[0].newPath).toBe("file1.ts");
    expect(files[1].newPath).toBe("file2.ts");
  });

  it("handles new file (old path is /dev/null)", () => {
    const files = parseUnifiedDiff(NEW_FILE_DIFF);
    expect(files).toHaveLength(1);
    expect(files[0].oldPath).toBe("/dev/null");
    expect(files[0].newPath).toBe("newfile.ts");
    expect(files[0].additions).toBe(3);
    expect(files[0].deletions).toBe(0);
  });

  it("handles deleted file (new path is /dev/null)", () => {
    const files = parseUnifiedDiff(DELETED_FILE_DIFF);
    expect(files).toHaveLength(1);
    expect(files[0].oldPath).toBe("oldfile.ts");
    expect(files[0].newPath).toBe("/dev/null");
    expect(files[0].additions).toBe(0);
    expect(files[0].deletions).toBe(2);
  });

  it("assigns correct line numbers", () => {
    const files = parseUnifiedDiff(SIMPLE_DIFF);
    const lines = files[0].hunks[0].lines;

    // First line is context: old=1, new=1
    expect(lines[0].type).toBe("context");
    expect(lines[0].oldLineNumber).toBe(1);
    expect(lines[0].newLineNumber).toBe(1);

    // Deletion: old line number only
    const deletion = lines.find((l) => l.type === "deletion");
    expect(deletion?.oldLineNumber).toBe(3);
    expect(deletion?.newLineNumber).toBeNull();

    // Addition: new line number only
    const addition = lines.find((l) => l.type === "addition");
    expect(addition?.newLineNumber).toBe(3);
    expect(addition?.oldLineNumber).toBeNull();
  });

  it("returns empty array for empty input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  it("returns empty array for non-diff input", () => {
    expect(parseUnifiedDiff("just some random text\nnothing here")).toEqual([]);
  });
});

describe("DiffViewer component", () => {
  it("renders 'No changes' for empty diff", () => {
    render(<DiffViewer diff="" />);
    expect(screen.getByText("No changes to display.")).toBeInTheDocument();
  });

  it("renders file header with path", () => {
    render(<DiffViewer diff={SIMPLE_DIFF} />);
    expect(screen.getByText("src/index.ts")).toBeInTheDocument();
  });

  it("renders addition and deletion stats", () => {
    render(<DiffViewer diff={SIMPLE_DIFF} />);
    expect(screen.getByText("+2")).toBeInTheDocument();
    expect(screen.getByText("-1")).toBeInTheDocument();
  });

  it("renders addition lines with green styling", () => {
    render(<DiffViewer diff={SIMPLE_DIFF} />);
    const additionLines = screen.getAllByTestId("diff-line-addition");
    expect(additionLines.length).toBe(2);
  });

  it("renders deletion lines with red styling", () => {
    render(<DiffViewer diff={SIMPLE_DIFF} />);
    const deletionLines = screen.getAllByTestId("diff-line-deletion");
    expect(deletionLines.length).toBe(1);
  });

  it("renders context lines", () => {
    render(<DiffViewer diff={SIMPLE_DIFF} />);
    const contextLines = screen.getAllByTestId("diff-line-context");
    expect(contextLines.length).toBeGreaterThan(0);
  });

  it("collapses and expands file sections", async () => {
    const user = userEvent.setup();
    render(<DiffViewer diff={SIMPLE_DIFF} />);

    // Initially expanded — table should be visible
    const additionLines = screen.getAllByTestId("diff-line-addition");
    expect(additionLines.length).toBe(2);

    // Click to collapse
    const fileHeader = screen.getByText("src/index.ts").closest("button")!;
    await user.click(fileHeader);

    // Lines should be hidden
    expect(screen.queryByTestId("diff-line-addition")).not.toBeInTheDocument();

    // Click to expand
    await user.click(fileHeader);
    expect(screen.getAllByTestId("diff-line-addition")).toHaveLength(2);
  });

  it("renders multiple files", () => {
    render(<DiffViewer diff={MULTI_FILE_DIFF} />);
    const fileSections = screen.getAllByTestId("diff-file");
    expect(fileSections).toHaveLength(2);
  });

  it("shows 'new' badge for new files", () => {
    render(<DiffViewer diff={NEW_FILE_DIFF} />);
    expect(screen.getByText("new")).toBeInTheDocument();
  });

  it("shows 'deleted' badge for deleted files", () => {
    render(<DiffViewer diff={DELETED_FILE_DIFF} />);
    expect(screen.getByText("deleted")).toBeInTheDocument();
  });

  it("truncates large diffs based on maxLinesPerFile", () => {
    // Generate a diff with many lines
    const manyAdditions = Array.from({ length: 50 }, (_, i) => `+line${i}`).join("\n");
    const largeDiff = `diff --git a/big.ts b/big.ts
--- a/big.ts
+++ b/big.ts
@@ -1,0 +1,50 @@
${manyAdditions}
`;
    render(<DiffViewer diff={largeDiff} maxLinesPerFile={10} />);
    expect(screen.getByText(/Diff truncated/)).toBeInTheDocument();
  });
});
