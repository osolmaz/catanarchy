// @vitest-environment jsdom

import type { NegotiationView } from "@catanarchy/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../../apps/web/src/App.js";

afterEach(cleanup);

const firstLegalAction = (container: HTMLElement): Element | null =>
  container.querySelector("[data-legal-vertex], [data-legal-edge]");

describe("web simulator", () => {
  it("renders the standard board and starts with legal settlements", () => {
    const { container } = render(<App />);

    expect(screen.getByRole("group", { name: "Catan game board" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Place settlement on / })).toHaveLength(54);
    expect(container.querySelectorAll("[data-hex-id]")).toHaveLength(19);
    expect(container.querySelectorAll("[data-terrain-art]")).toHaveLength(19);
    expect(
      [...container.querySelectorAll("[data-terrain-art]")].every((image) =>
        image.getAttribute("href")?.startsWith("/assets/colonist/tile-"),
      ),
    ).toBe(true);
    expect(container.querySelector('.robber[href="/assets/colonist/robber.svg"]')).toBeTruthy();
    expect(container.querySelectorAll("[data-number-token]")).toHaveLength(18);
    expect(
      container.querySelectorAll('[data-number-token="6"] [data-probability-pips="5"]'),
    ).toHaveLength(2);
    expect(
      container.querySelectorAll('[data-number-token="12"] [data-probability-pips="1"]'),
    ).toHaveLength(1);
    expect(container.querySelectorAll("[data-legal-vertex]")).toHaveLength(54);
    expect(container.querySelectorAll("[data-harbor-edge]")).toHaveLength(9);
  });

  it("places a settlement and then offers adjacent roads", () => {
    const { container } = render(<App />);
    const settlement = container.querySelector("[data-legal-vertex]");
    if (settlement === null) throw new Error("Expected a legal settlement.");

    fireEvent.click(settlement);

    expect(container.querySelectorAll("[data-building-vertex]")).toHaveLength(1);
    expect(
      container.querySelector('[data-building-vertex][href="/assets/colonist/settlement-red.svg"]'),
    ).toBeTruthy();
    expect(container.querySelectorAll("[data-legal-vertex]")).toHaveLength(0);
    expect(container.querySelectorAll("[data-legal-edge]").length).toBeGreaterThanOrEqual(2);

    const road = container.querySelector("[data-legal-edge]");
    if (road === null) throw new Error("Expected a legal road.");
    fireEvent.click(road);

    expect(
      container.querySelector('[data-road-edge][href="/assets/colonist/road-red.svg"]'),
    ).toBeTruthy();
  });

  it("completes four-player initial placement through board clicks", () => {
    const { container } = render(<App />);
    for (let turn = 0; turn < 16; turn += 1) {
      const action = firstLegalAction(container);
      if (action === null) throw new Error(`Expected legal action ${turn + 1}.`);
      fireEvent.click(action);
    }

    expect(screen.getByText("Red: roll the dice (turn 1)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Roll dice" })).toBeTruthy();
    const victoryPoints = [...container.querySelectorAll(".players tbody td:first-of-type")];
    expect(victoryPoints.map((cell) => cell.textContent)).toEqual(["2", "2", "2", "2"]);
    expect(screen.getByText("2", { selector: ".hand b" })).toBeTruthy();
    expect(container.querySelectorAll("[data-building-vertex]")).toHaveLength(8);
    expect(container.querySelectorAll("[data-road-edge]")).toHaveLength(8);
    expect(firstLegalAction(container)).toBeNull();
  });

  it("rolls production dice and advances to the next turn", () => {
    const { container } = render(<App />);
    fireEvent.change(screen.getByLabelText("Seed"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "New game" }));
    for (let turn = 0; turn < 16; turn += 1) {
      const action = firstLegalAction(container);
      if (action === null) throw new Error(`Expected legal action ${turn + 1}.`);
      fireEvent.click(action);
    }

    fireEvent.click(screen.getByRole("button", { name: "Roll dice" }));
    expect(screen.getByText(/Red: trade, build, play a card, or end turn after/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "End turn" }));
    expect(screen.getByText("Blue: roll the dice (turn 2)")).toBeTruthy();
  });

  it("moves the robber after a seven", () => {
    const { container } = render(<App />);
    for (let turn = 0; turn < 16; turn += 1) {
      fireEvent.click(firstLegalAction(container)!);
    }

    fireEvent.click(screen.getByRole("button", { name: "Roll dice" }));
    expect(screen.getByText("Red: move the robber (roll)")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /^Move robber/ })[0]!);
    expect(screen.getByText(/Red: trade, build, play a card, or end turn after/)).toBeTruthy();
  });

  it("navigates accepted-command frames without enabling historical actions", () => {
    const { container } = render(<App />);
    fireEvent.click(container.querySelector("[data-legal-vertex]")!);
    fireEvent.click(container.querySelector("[data-legal-edge]")!);

    expect(screen.getByText("3 / 3")).toBeTruthy();
    expect(container.querySelectorAll("[data-road-edge]")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));

    expect(screen.getByText("2 / 3")).toBeTruthy();
    expect(container.querySelectorAll("[data-road-edge]")).toHaveLength(0);
    expect(firstLegalAction(container)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(container.querySelectorAll("[data-road-edge]")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Frame"), { target: { value: "0" } });
    expect(screen.getByText("1 / 3")).toBeTruthy();
    expect(container.querySelectorAll("[data-building-vertex]")).toHaveLength(0);
  });

  it("supports keyboard placement controls", () => {
    const { container } = render(<App />);
    const settlement = container.querySelector("[data-legal-vertex]");
    if (settlement === null) throw new Error("Expected a legal settlement.");

    fireEvent.keyDown(settlement, { key: "Enter" });

    expect(container.querySelectorAll("[data-building-vertex]")).toHaveLength(1);
  });

  it("starts a three-player game with the selected seed", () => {
    const { container } = render(<App />);
    fireEvent.change(screen.getByLabelText("Seed"), { target: { value: "99" } });
    fireEvent.change(screen.getByLabelText("Players"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "New game" }));

    expect(screen.getByText("local-99-3")).toBeTruthy();
    expect(container.querySelectorAll(".players tbody tr")).toHaveLength(3);
  });

  it("rejects an invalid seed without replacing the game", () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText("Seed"), { target: { value: "-1" } });
    fireEvent.click(screen.getByRole("button", { name: "New game" }));

    expect(screen.getByText("Seed must be an unsigned 32-bit integer.")).toBeTruthy();
    expect(screen.getByText("local-42-4")).toBeTruthy();
  });

  it("renders a matching projected negotiation view supplied by the harness transport", () => {
    const negotiation: NegotiationView = {
      schema: "catanarchy.negotiation-view.v1",
      matchId: "local-42-4",
      sequence: 1,
      events: [
        {
          schema: "catanarchy.negotiation-event.v1",
          matchId: "local-42-4",
          sequence: 0,
          gameSequence: 0,
          event: {
            type: "negotiation.message-sent",
            round: 1,
            playerId: "red",
            scope: { type: "public" },
            text: "I can trade lumber for brick.",
          },
        },
      ],
      offers: [],
      promises: [],
      evidence: [],
    };

    render(<App negotiation={negotiation} />);

    expect(screen.getByText("red (public): I can trade lumber for brick.")).toBeTruthy();
  });
});
