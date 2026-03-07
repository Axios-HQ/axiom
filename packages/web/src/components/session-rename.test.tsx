// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { SessionRename } from "./session-rename";

afterEach(cleanup);

describe("SessionRename", () => {
  const defaultProps = {
    sessionId: "session-123",
    currentTitle: "My Session",
    isEditing: false,
    onStartEdit: vi.fn(),
    onFinishEdit: vi.fn(),
    onRename: vi.fn(async () => {}),
  };

  it("renders the title as text when not editing", () => {
    render(<SessionRename {...defaultProps} />);
    expect(screen.getByText("My Session")).toBeDefined();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("calls onStartEdit on double-click", () => {
    const onStartEdit = vi.fn();
    render(<SessionRename {...defaultProps} onStartEdit={onStartEdit} />);
    fireEvent.doubleClick(screen.getByText("My Session"));
    expect(onStartEdit).toHaveBeenCalledOnce();
  });

  it("renders an input when editing", () => {
    render(<SessionRename {...defaultProps} isEditing={true} />);
    const input = screen.getByRole("textbox");
    expect(input).toBeDefined();
    expect((input as HTMLInputElement).value).toBe("My Session");
  });

  it("calls onRename with new title on Enter", async () => {
    const onRename = vi.fn(async () => {});
    const onFinishEdit = vi.fn();
    render(
      <SessionRename
        {...defaultProps}
        isEditing={true}
        onRename={onRename}
        onFinishEdit={onFinishEdit}
      />
    );

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "New Title" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(onRename).toHaveBeenCalledWith("session-123", "New Title");
      expect(onFinishEdit).toHaveBeenCalled();
    });
  });

  it("cancels editing on Escape without saving", () => {
    const onRename = vi.fn(async () => {});
    const onFinishEdit = vi.fn();
    render(
      <SessionRename
        {...defaultProps}
        isEditing={true}
        onRename={onRename}
        onFinishEdit={onFinishEdit}
      />
    );

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "New Title" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onRename).not.toHaveBeenCalled();
    expect(onFinishEdit).toHaveBeenCalledOnce();
  });

  it("does not call onRename when title is unchanged", async () => {
    const onRename = vi.fn(async () => {});
    const onFinishEdit = vi.fn();
    render(
      <SessionRename
        {...defaultProps}
        isEditing={true}
        onRename={onRename}
        onFinishEdit={onFinishEdit}
      />
    );

    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(onRename).not.toHaveBeenCalled();
      expect(onFinishEdit).toHaveBeenCalled();
    });
  });

  it("does not call onRename when title is empty", async () => {
    const onRename = vi.fn(async () => {});
    const onFinishEdit = vi.fn();
    render(
      <SessionRename
        {...defaultProps}
        isEditing={true}
        onRename={onRename}
        onFinishEdit={onFinishEdit}
      />
    );

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(onRename).not.toHaveBeenCalled();
      expect(onFinishEdit).toHaveBeenCalled();
    });
  });
});
