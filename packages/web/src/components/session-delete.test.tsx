// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { SessionDelete } from "./session-delete";

afterEach(cleanup);

describe("SessionDelete", () => {
  const defaultProps = {
    sessionId: "session-123",
    onDelete: vi.fn(async () => {}),
  };

  it("renders the delete button", () => {
    render(<SessionDelete {...defaultProps} />);
    expect(screen.getByLabelText("Delete session")).toBeDefined();
  });

  it("shows confirmation dialog on click", () => {
    render(<SessionDelete {...defaultProps} />);
    fireEvent.click(screen.getByLabelText("Delete session"));
    expect(screen.getByText("Delete?")).toBeDefined();
    expect(screen.getByLabelText("Confirm delete session")).toBeDefined();
    expect(screen.getByLabelText("Cancel delete")).toBeDefined();
  });

  it("calls onDelete when confirmed", async () => {
    const onDelete = vi.fn(async () => {});
    render(<SessionDelete {...defaultProps} onDelete={onDelete} />);

    fireEvent.click(screen.getByLabelText("Delete session"));
    fireEvent.click(screen.getByLabelText("Confirm delete session"));

    await waitFor(() => {
      expect(onDelete).toHaveBeenCalledWith("session-123");
    });
  });

  it("hides confirmation dialog on cancel", () => {
    render(<SessionDelete {...defaultProps} />);

    fireEvent.click(screen.getByLabelText("Delete session"));
    expect(screen.getByText("Delete?")).toBeDefined();

    fireEvent.click(screen.getByLabelText("Cancel delete"));
    expect(screen.queryByText("Delete?")).toBeNull();
  });

  it("does not call onDelete when cancelled", () => {
    const onDelete = vi.fn(async () => {});
    render(<SessionDelete {...defaultProps} onDelete={onDelete} />);

    fireEvent.click(screen.getByLabelText("Delete session"));
    fireEvent.click(screen.getByLabelText("Cancel delete"));

    expect(onDelete).not.toHaveBeenCalled();
  });
});
