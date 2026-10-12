import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DateRangeSelect } from "./DateRangeSelect";

function setup(props: Partial<Parameters<typeof DateRangeSelect>[0]> = {}) {
  const onPreset = vi.fn();
  const onCustom = vi.fn();
  render(<DateRangeSelect value="7d" custom={null} onPreset={onPreset} onCustom={onCustom} {...props} />);
  return { onPreset, onCustom };
}

describe("DateRangeSelect", () => {
  it("lists the presets, then a custom range behind a separator", async () => {
    const { onPreset } = setup();
    await userEvent.click(screen.getByRole("combobox", { name: "Date range" }));
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Today", "Last 7 days", "Last 30 days", "Last 90 days", "Custom range…"]);
    await userEvent.click(screen.getByRole("option", { name: "Last 30 days" }));
    expect(onPreset).toHaveBeenCalledWith("30d");
  });

  it("opens two day fields for a custom range and hands back the days in order", async () => {
    const { onCustom, onPreset } = setup();
    await userEvent.click(screen.getByRole("combobox", { name: "Date range" }));
    await userEvent.click(screen.getByRole("option", { name: "Custom range…" }));

    const dialog = await screen.findByRole("dialog", { name: "Custom date range" });
    fireEvent.change(within(dialog).getByLabelText("From"), { target: { value: "2026-10-05" } });
    fireEvent.change(within(dialog).getByLabelText("To"), { target: { value: "2026-10-01" } });
    await userEvent.click(within(dialog).getByRole("button", { name: "Apply" }));

    expect(onCustom).toHaveBeenCalledWith({ from: "2026-10-01", to: "2026-10-05" });
    expect(onPreset).not.toHaveBeenCalled();
  });

  it("refuses a range longer than a year", async () => {
    const { onCustom } = setup();
    await userEvent.click(screen.getByRole("combobox", { name: "Date range" }));
    await userEvent.click(screen.getByRole("option", { name: "Custom range…" }));
    const dialog = await screen.findByRole("dialog", { name: "Custom date range" });
    fireEvent.change(within(dialog).getByLabelText("From"), { target: { value: "2024-01-01" } });
    fireEvent.change(within(dialog).getByLabelText("To"), { target: { value: "2026-01-01" } });
    await userEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Pick 366 days or fewer.");
    expect(onCustom).not.toHaveBeenCalled();
  });

  it("shows an active custom range on the trigger, with a button that reopens its days", async () => {
    setup({ value: "custom", custom: { from: "2026-10-01", to: "2026-10-05" } });
    expect(screen.getByRole("combobox", { name: "Date range" })).toHaveTextContent("Oct 1 – Oct 5");
    await userEvent.click(screen.getByRole("button", { name: "Edit custom range" }));
    const dialog = await screen.findByRole("dialog", { name: "Custom date range" });
    expect(within(dialog).getByLabelText("From")).toHaveValue("2026-10-01");
    expect(within(dialog).getByLabelText("To")).toHaveValue("2026-10-05");
  });
});
