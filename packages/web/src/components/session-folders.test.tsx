// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SessionFolderList, DraggableSession } from "./session-folders";
import type { SessionFolder } from "@/hooks/use-session-folders";

afterEach(cleanup);

describe("SessionFolderList", () => {
  const mockFolders: SessionFolder[] = [
    { id: "folder-1", name: "Work", sessionIds: ["s1", "s2"] },
    { id: "folder-2", name: "Personal", sessionIds: ["s3"] },
  ];

  const defaultProps = {
    folders: mockFolders,
    expandedFolderIds: new Set<string>(),
    onToggleFolder: vi.fn(),
    onCreateFolder: vi.fn(),
    onRenameFolder: vi.fn(),
    onDeleteFolder: vi.fn(),
    onDropSession: vi.fn(),
    renderFolderContent: vi.fn(() => <div>folder content</div>),
  };

  it("renders folder names", () => {
    render(<SessionFolderList {...defaultProps} />);
    expect(screen.getByText("Work")).toBeDefined();
    expect(screen.getByText("Personal")).toBeDefined();
  });

  it("shows session counts for each folder", () => {
    render(<SessionFolderList {...defaultProps} />);
    expect(screen.getByText("2")).toBeDefined();
    expect(screen.getByText("1")).toBeDefined();
  });

  it("shows create folder input when clicking create button", () => {
    render(<SessionFolderList {...defaultProps} />);
    fireEvent.click(screen.getByLabelText("Create folder"));
    expect(screen.getByLabelText("New folder name")).toBeDefined();
  });

  it("calls onCreateFolder when submitting new folder", () => {
    const onCreateFolder = vi.fn();
    render(<SessionFolderList {...defaultProps} onCreateFolder={onCreateFolder} />);

    fireEvent.click(screen.getByLabelText("Create folder"));
    const input = screen.getByLabelText("New folder name");
    fireEvent.change(input, { target: { value: "New Folder" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onCreateFolder).toHaveBeenCalledWith("New Folder");
  });

  it("toggles folder expansion on click", () => {
    const onToggleFolder = vi.fn();
    render(<SessionFolderList {...defaultProps} onToggleFolder={onToggleFolder} />);
    fireEvent.click(screen.getByLabelText("Folder: Work"));
    expect(onToggleFolder).toHaveBeenCalledWith("folder-1");
  });

  it("renders folder content when expanded", () => {
    const renderFolderContent = vi.fn(() => <div data-testid="content">sessions</div>);
    render(
      <SessionFolderList
        {...defaultProps}
        expandedFolderIds={new Set(["folder-1"])}
        renderFolderContent={renderFolderContent}
      />
    );
    expect(screen.getByTestId("content")).toBeDefined();
    expect(renderFolderContent).toHaveBeenCalledWith(mockFolders[0]);
  });

  it("does not render folder content when collapsed", () => {
    const renderFolderContent = vi.fn(() => <div data-testid="content">sessions</div>);
    render(
      <SessionFolderList
        {...defaultProps}
        expandedFolderIds={new Set()}
        renderFolderContent={renderFolderContent}
      />
    );
    expect(screen.queryByTestId("content")).toBeNull();
  });
});

describe("DraggableSession", () => {
  it("renders children", () => {
    render(
      <DraggableSession sessionId="s1">
        <span>Session content</span>
      </DraggableSession>
    );
    expect(screen.getByText("Session content")).toBeDefined();
  });

  it("sets session ID on drag start", () => {
    render(
      <DraggableSession sessionId="s1">
        <span>Session content</span>
      </DraggableSession>
    );

    const draggable = screen.getByText("Session content").parentElement!;
    const setData = vi.fn();
    const dataTransfer = { setData, effectAllowed: "" };
    fireEvent.dragStart(draggable, { dataTransfer });

    expect(setData).toHaveBeenCalledWith("text/session-id", "s1");
  });
});
