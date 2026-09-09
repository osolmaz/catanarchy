// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../../apps/web/src/App.js";

afterEach(cleanup);

const firstLegalAction = (container: HTMLElement): Element | null =>
  container.querySelector("[data-legal-vertex], [data-legal-edge]");

describe("web simulator", () => {
  it("renders the standard board and starts with legal settlements", () => {
    const { container } = render(<App />);

    expect(screen.getByRole("heading", { name: "Build the first settlements" })).toBeTruthy();
    expect(container.querySelectorAll("[data-hex-id]")).toHaveLength(19);
    expect(container.querySelectorAll("[data-legal-vertex]")).toHaveLength(54);
    expect(container.querySelectorAll("[data-harbor-edge]")).toHaveLength(9);
  });

  it("places a settlement and then offers adjacent roads", () => {
    const { container } = render(<App />);
    const settlement = container.querySelector("[data-legal-vertex]");
    if (settlement === null) throw new Error("Expected a legal settlement.");

    fireEvent.click(settlement);

    expect(container.querySelectorAll("[data-building-vertex]")).toHaveLength(1);
    expect(container.querySelectorAll("[data-legal-vertex]")).toHaveLength(0);
    expect(container.querySelectorAll("[data-legal-edge]").length).toBeGreaterThanOrEqual(2);
  });

  it("completes four-player initial placement through board clicks", () => {
    const { container } = render(<App />);
    for (let turn = 0; turn < 16; turn += 1) {
      const action = firstLegalAction(container);
      if (action === null) throw new Error(`Expected legal action ${turn + 1}.`);
      fireEvent.click(action);
    }

    expect(screen.getByText("Initial placement complete")).toBeTruthy();
    expect(container.querySelectorAll("[data-building-vertex]")).toHaveLength(8);
    expect(container.querySelectorAll("[data-road-edge]")).toHaveLength(8);
    expect(firstLegalAction(container)).toBeNull();
  });

  it("navigates accepted-command frames without enabling historical actions", () => {
    const { container } = render(<App />);
    fireEvent.click(container.querySelector("[data-legal-vertex]")!);
    fireEvent.click(container.querySelector("[data-legal-edge]")!);

    expect(screen.getByText("Frame 3 of 3")).toBeTruthy();
    expect(container.querySelectorAll("[data-road-edge]")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));

    expect(screen.getByText("Frame 2 of 3")).toBeTruthy();
    expect(container.querySelectorAll("[data-road-edge]")).toHaveLength(0);
    expect(firstLegalAction(container)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(container.querySelectorAll("[data-road-edge]")).toHaveLength(1);
  });

  it("supports keyboard placement controls", () => {
    const { container } = render(<App />);
    const settlement = container.querySelector("[data-legal-vertex]");
    if (settlement === null) throw new Error("Expected a legal settlement.");

    fireEvent.keyDown(settlement, { key: "Enter" });

    expect(container.querySelectorAll("[data-building-vertex]")).toHaveLength(1);
  });

  it("starts a three-player game with the selected seed", () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText("Seed"), { target: { value: "99" } });
    fireEvent.change(screen.getByLabelText("Players"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "New game" }));

    expect(screen.getByText("local-99-3")).toBeTruthy();
    expect(screen.getAllByText(/settlements ·/)).toHaveLength(3);
  });

  it("rejects an invalid seed without replacing the game", () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText("Seed"), { target: { value: "-1" } });
    fireEvent.click(screen.getByRole("button", { name: "New game" }));

    expect(screen.getByText("Seed must be an unsigned 32-bit integer.")).toBeTruthy();
    expect(screen.getByText("local-42-4")).toBeTruthy();
  });
});
