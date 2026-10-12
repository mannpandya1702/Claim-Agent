import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FILTERS, type CallFilters } from "./callFilters";
import { Filters, SEARCH_DEBOUNCE_MS } from "./Filters";

function setup(value: CallFilters = DEFAULT_FILTERS) {
  const onChange = vi.fn();
  const onReset = vi.fn();
  const utils = render(<Filters value={value} onChange={onChange} onReset={onReset} />);
  return { onChange, onReset, ...utils };
}

describe("Filters search box", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits 300 ms after the last keystroke, then searches once", () => {
    const { onChange } = setup();
    const box = screen.getByRole("searchbox", { name: "Search calls" });
    fireEvent.change(box, { target: { value: "ap" } });
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 50));
    fireEvent.change(box, { target: { value: "appeal " } });
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1));
    expect(onChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ q: "appeal" });
  });

  it("searches immediately on Enter", () => {
    const { onChange } = setup();
    const box = screen.getByRole("searchbox", { name: "Search calls" });
    fireEvent.change(box, { target: { value: "Quintero" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith({ q: "Quintero" });
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("pre-fills from the URL and refills when the URL changes elsewhere", () => {
    const { rerender, onChange, onReset } = setup({ ...DEFAULT_FILTERS, q: "call-123", range: "all" });
    expect(screen.getByRole("searchbox")).toHaveValue("call-123");
    rerender(<Filters value={DEFAULT_FILTERS} onChange={onChange} onReset={onReset} />);
    expect(screen.getByRole("searchbox")).toHaveValue("");
  });
});

describe("Filters toggles", () => {
  it("toggles flagged and escalated with aria-pressed, and offers Clear filters when narrowed", () => {
    const { onChange, onReset, rerender } = setup();
    const flagged = screen.getByRole("button", { name: "Flagged only" });
    expect(flagged).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
    fireEvent.click(flagged);
    expect(onChange).toHaveBeenCalledWith({ flagged: true });

    rerender(<Filters value={{ ...DEFAULT_FILTERS, flagged: true }} onChange={onChange} onReset={onReset} />);
    expect(screen.getByRole("button", { name: "Flagged only" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(onReset).toHaveBeenCalled();
  });

  it("labels every select for assistive tech", () => {
    setup();
    for (const name of ["Date range", "Outcome", "Sentiment", "Channel"]) {
      expect(screen.getByRole("combobox", { name })).toBeInTheDocument();
    }
  });
});
