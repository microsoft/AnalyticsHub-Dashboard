import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { CrossVendorPanel } from "./page-panel-gate";
import { StageFilterContext, onlyStages, pageStages } from "@/hooks/stage-filter.context";
import type { CrossVendorPage } from "./page-panels";

vi.mock("@/components/vega-visual", () => ({ VegaVisual: ({ header }: { header?: { title?: string } }) => <figure aria-label={header?.title} /> }));
vi.mock("@/hooks/theme.context", () => ({ useThemeContext: () => ({ theme: {}, isDark: false, toggleTheme() {} }) }));

afterEach(() => vi.unstubAllEnvs());
beforeAll(async () => { await import("./page-panels"); });

const titles: Record<CrossVendorPage, string> = {
    executive: "All AI tools",
    adoption: "People using more than one AI tool",
    consumption: "Copilot credits beside other AI tools' spend",
    efficiency: "Which tool people use for which task",
    leaderboards: "Most active people across AI tools",
};

describe("cross-vendor page panels", () => {
    it.each(Object.entries(titles))("adds the %s panel only when the flag is on, without a badge", async (page, title) => {
        vi.stubEnv("VITE_CROSS_VENDOR_DEMO", "true");
        const { container } = render(<StageFilterContext.Provider value={pageStages("all")}><CrossVendorPanel page={page as CrossVendorPage} /></StageFilterContext.Provider>);
        expect(await screen.findByRole("heading", { level: 2, name: title })).toBeInTheDocument();
        const root = container.querySelector(`[data-cross-vendor-panel="${page}"]`)!;
        expect(root).toHaveAttribute("data-provenance", "synthetic");
        expect(root).toHaveAttribute("data-print", "hide");
        expect(root.textContent).not.toMatch(/synthetic/i);
        expect(root.querySelector("[id^='stage-']")).toBeNull();
    });

    it("renders nothing with the flag off or inside a report pack", () => {
        vi.stubEnv("VITE_CROSS_VENDOR_DEMO", "");
        const off = render(<CrossVendorPanel page="executive" />);
        expect(off.container).toBeEmptyDOMElement();
        off.unmount();
        vi.stubEnv("VITE_CROSS_VENDOR_DEMO", "true");
        const pack = render(<StageFilterContext.Provider value={onlyStages(["the-bottom-line"])}><CrossVendorPanel page="executive" /></StageFilterContext.Provider>);
        expect(pack.container).toBeEmptyDOMElement();
    });

    it("keeps credits and USD apart on the consumption panel", async () => {
        vi.stubEnv("VITE_CROSS_VENDOR_DEMO", "true");
        render(<CrossVendorPanel page="consumption" />);
        expect(await screen.findByRole("figure", { name: "Microsoft 365 Copilot credits" })).toBeInTheDocument();
        expect(screen.getByRole("figure", { name: "Spend on other AI tools" })).toBeInTheDocument();
        expect(screen.getByText(/never added/)).toBeInTheDocument();
    });
});
