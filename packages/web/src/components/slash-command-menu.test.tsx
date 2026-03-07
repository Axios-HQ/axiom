// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { SlashCommandMenu, type SlashCommand } from "./slash-command-menu";

afterEach(() => {
  cleanup();
});

function createCommands(overrides?: Partial<Record<string, () => void>>): SlashCommand[] {
  return [
    {
      name: "model",
      label: "Model",
      description: "Show model selector",
      action: overrides?.model ?? vi.fn(),
    },
    {
      name: "branch",
      label: "Branch",
      description: "Show branch selector",
      action: overrides?.branch ?? vi.fn(),
    },
    {
      name: "stop",
      label: "Stop",
      description: "Stop the current agent",
      action: overrides?.stop ?? vi.fn(),
    },
    {
      name: "archive",
      label: "Archive",
      description: "Archive the session",
      action: overrides?.archive ?? vi.fn(),
    },
  ];
}

describe("SlashCommandMenu", () => {
  it("does not render when input does not start with /", () => {
    const commands = createCommands();
    render(
      <SlashCommandMenu
        inputValue="hello"
        commands={commands}
        onCommandSelect={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(screen.queryByTestId("slash-command-menu")).not.toBeInTheDocument();
  });

  it("renders all commands when input is just /", () => {
    const commands = createCommands();
    render(
      <SlashCommandMenu
        inputValue="/"
        commands={commands}
        onCommandSelect={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByTestId("slash-command-menu")).toBeInTheDocument();
    expect(screen.getByText("/model")).toBeInTheDocument();
    expect(screen.getByText("/branch")).toBeInTheDocument();
    expect(screen.getByText("/stop")).toBeInTheDocument();
    expect(screen.getByText("/archive")).toBeInTheDocument();
  });

  it("filters commands as user types", () => {
    const commands = createCommands();
    render(
      <SlashCommandMenu
        inputValue="/mo"
        commands={commands}
        onCommandSelect={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByText("/model")).toBeInTheDocument();
    expect(screen.queryByText("/branch")).not.toBeInTheDocument();
    expect(screen.queryByText("/stop")).not.toBeInTheDocument();
    expect(screen.queryByText("/archive")).not.toBeInTheDocument();
  });

  it("hides when no commands match filter", () => {
    const commands = createCommands();
    render(
      <SlashCommandMenu
        inputValue="/xyz"
        commands={commands}
        onCommandSelect={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(screen.queryByTestId("slash-command-menu")).not.toBeInTheDocument();
  });

  it("shows command descriptions", () => {
    const commands = createCommands();
    render(
      <SlashCommandMenu
        inputValue="/"
        commands={commands}
        onCommandSelect={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByText("Show model selector")).toBeInTheDocument();
    expect(screen.getByText("Show branch selector")).toBeInTheDocument();
  });

  it("calls action and onCommandSelect when a command is clicked", async () => {
    const user = userEvent.setup();
    const modelAction = vi.fn();
    const onCommandSelect = vi.fn();
    const commands = createCommands({ model: modelAction });

    render(
      <SlashCommandMenu
        inputValue="/"
        commands={commands}
        onCommandSelect={onCommandSelect}
        onDismiss={vi.fn()}
      />
    );

    await user.click(screen.getByText("/model"));
    expect(modelAction).toHaveBeenCalledOnce();
    expect(onCommandSelect).toHaveBeenCalledOnce();
    expect(onCommandSelect).toHaveBeenCalledWith(
      expect.objectContaining({ name: "model" })
    );
  });

  it("navigates with arrow keys and selects with Enter", async () => {
    const user = userEvent.setup();
    const stopAction = vi.fn();
    const onCommandSelect = vi.fn();
    const commands = createCommands({ stop: stopAction });

    render(
      <SlashCommandMenu
        inputValue="/"
        commands={commands}
        onCommandSelect={onCommandSelect}
        onDismiss={vi.fn()}
      />
    );

    // First item is active by default (model)
    // Move down twice to reach "stop" (index 2)
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");

    expect(stopAction).toHaveBeenCalledOnce();
    expect(onCommandSelect).toHaveBeenCalledWith(
      expect.objectContaining({ name: "stop" })
    );
  });

  it("wraps around when navigating past last item", async () => {
    const user = userEvent.setup();
    const modelAction = vi.fn();
    const onCommandSelect = vi.fn();
    const commands = createCommands({ model: modelAction });

    render(
      <SlashCommandMenu
        inputValue="/"
        commands={commands}
        onCommandSelect={onCommandSelect}
        onDismiss={vi.fn()}
      />
    );

    // 4 commands. Press down 4 times to wrap back to first.
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
    await user.keyboard("{Enter}");

    expect(modelAction).toHaveBeenCalledOnce();
  });

  it("wraps around when navigating up from first item", async () => {
    const user = userEvent.setup();
    const archiveAction = vi.fn();
    const onCommandSelect = vi.fn();
    const commands = createCommands({ archive: archiveAction });

    render(
      <SlashCommandMenu
        inputValue="/"
        commands={commands}
        onCommandSelect={onCommandSelect}
        onDismiss={vi.fn()}
      />
    );

    // From first item, go up to last (archive)
    await user.keyboard("{ArrowUp}");
    await user.keyboard("{Enter}");

    expect(archiveAction).toHaveBeenCalledOnce();
  });

  it("dismisses on Escape", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    const commands = createCommands();

    render(
      <SlashCommandMenu
        inputValue="/"
        commands={commands}
        onCommandSelect={vi.fn()}
        onDismiss={onDismiss}
      />
    );

    await user.keyboard("{Escape}");
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("highlights active item on mouse enter", async () => {
    const user = userEvent.setup();
    const commands = createCommands();

    render(
      <SlashCommandMenu
        inputValue="/"
        commands={commands}
        onCommandSelect={vi.fn()}
        onDismiss={vi.fn()}
      />
    );

    // Hover over the "stop" button
    const stopButton = screen.getByText("/stop").closest("button")!;
    await user.hover(stopButton);

    // The stop button should now be aria-selected
    expect(stopButton).toHaveAttribute("aria-selected", "true");
  });

  it("filters case-insensitively", () => {
    const commands = createCommands();
    render(
      <SlashCommandMenu
        inputValue="/MO"
        commands={commands}
        onCommandSelect={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByText("/model")).toBeInTheDocument();
  });
});
