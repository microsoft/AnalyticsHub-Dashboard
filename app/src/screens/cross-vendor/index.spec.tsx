import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CrossVendorScreen } from "./index";
import { StageFilterContext, pageStages } from "@/hooks/stage-filter.context";
import { availableDestinations, destinations, isPackable } from "@/components/destinations";
import { PAGE_SOURCES } from "@/lib/freshness";
import { parseHash } from "@/lib/route";
import { prefetchTargets } from "@/components/prefetch-targets";
import portfolio from "./portfolio.json";
import contract from "./contract.json";
import { scopedMetrics, metricValue, periodLabel } from "./model";

vi.mock("@/components/vega-visual", () => ({ VegaVisual: ({ header }: { header?: { title?: string } }) => <figure aria-label={header?.title} /> }));
vi.mock("@/hooks/theme.context", () => ({ useThemeContext: () => ({ theme: {}, isDark: false, toggleTheme() {} }) }));

afterEach(() => vi.unstubAllEnvs());

describe("cross-vendor extension", () => {
    it("pins a synthetic, known-source portfolio and matching contract", () => {
        expect(portfolio.contract_version).toBe("1.0.0");
        expect(portfolio.contract_version).toBe(contract.contract_version);
        expect(portfolio.sources).toHaveLength(4);
        expect(portfolio.observations).toHaveLength(58);
        expect(portfolio.sources.every(s => s.classification === "synthetic")).toBe(true);
        expect(portfolio.observations.every(o => portfolio.sources.some(s => s.source_id === o.source_id))).toBe(true);
    });

    it("is opt-in and does not change default available destinations", () => {
        vi.stubEnv("VITE_CROSS_VENDOR_DEMO", "");
        expect(availableDestinations({}).some(d => d.id === "cross-vendor")).toBe(false);
        vi.stubEnv("VITE_CROSS_VENDOR_DEMO", "true");
        expect(availableDestinations({}).some(d => d.id === "cross-vendor")).toBe(true);
    });

    it("keeps synthetic data out of packs, live freshness and background prefetch", () => {
        vi.stubEnv("VITE_CROSS_VENDOR_DEMO", "true");
        const demo = destinations.find(d => d.id === "cross-vendor")!;
        expect(isPackable(demo)).toBe(false);
        expect(PAGE_SOURCES["cross-vendor"]).toEqual([]);
        expect(prefetchTargets(availableDestinations({}), "executive", "the-bottom-line", 100).some(t => t.id === "cross-vendor")).toBe(false);
        expect(prefetchTargets(availableDestinations({}), "cross-vendor", "vendor-usage", 100).some(t => t.id === "cross-vendor")).toBe(false);
        expect(parseHash("#/cross-vendor/vendor-coverage").route).toEqual({ kind: "destination", id: "cross-vendor", stage: "vendor-coverage" });
    });

    it("renders native filters in the app stage without generating missing zeros", () => {
        vi.stubEnv("VITE_CROSS_VENDOR_DEMO", "true");
        render(<StageFilterContext.Provider value={pageStages("vendor-usage")}><CrossVendorScreen /></StageFilterContext.Provider>);
        expect(screen.queryByRole("note", { name: "Synthetic demo disclosure" })).not.toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Vendor"), { target: { value: "openai_chatgpt" } });
        fireEvent.change(screen.getByLabelText("Native product"), { target: { value: "Codex" } });
        expect(screen.getAllByText(/2026-10-01 to 2026-10-26/).length).toBeGreaterThan(0);
        expect(screen.getAllByText("0").length).toBeGreaterThan(0);
        fireEvent.change(screen.getByLabelText("Vendor"), { target: { value: "microsoft" } });
        expect(screen.getByText(/No observations loaded.*Missing is not zero/)).toBeInTheDocument();
        expect(screen.queryByRole("table")).not.toBeInTheDocument();
    });

    it("uses the view name in the disabled-build message", () => {
        vi.stubEnv("VITE_CROSS_VENDOR_DEMO", "");
        render(<StageFilterContext.Provider value={pageStages("vendor-usage")}><CrossVendorScreen /></StageFilterContext.Provider>);
        expect(screen.getByText("The synthetic cross-vendor view is not enabled for this build.")).toBeInTheDocument();
    });

    it("uses the preview brand in the portfolio description", () => {
        vi.stubEnv("VITE_CROSS_VENDOR_DEMO", "true");
        vi.stubEnv("VITE_DATAHUB_PREVIEW", "true");
        render(<StageFilterContext.Provider value={pageStages("vendor-portfolio")}><CrossVendorScreen /></StageFilterContext.Provider>);
        expect(screen.getByText(/Source-native signals inside DataHub/)).toBeInTheDocument();
    });

    it("keeps one concise synthetic disclosure, in Methodology only", () => {
        vi.stubEnv("VITE_CROSS_VENDOR_DEMO", "true");
        const { unmount } = render(<StageFilterContext.Provider value={pageStages("vendor-methodology")}><CrossVendorScreen /></StageFilterContext.Provider>);
        expect(screen.getByRole("note", { name: "Synthetic demo disclosure" })).toHaveTextContent(
            "All data in this view is synthetic and illustrative. It is not live or verified: no customer data, real usage, verified billing or ROI. App-wide date and organization filters do not apply.",
        );
        expect(screen.getByText(/seed 20261025, run synthetic-scenario-2026-10-25/)).toBeInTheDocument();
        unmount();
        for (const stage of ["vendor-portfolio", "vendor-adoption", "vendor-coding", "vendor-spend"] as const) {
            const view = render(<StageFilterContext.Provider value={pageStages(stage)}><CrossVendorScreen /></StageFilterContext.Provider>);
            expect(screen.queryByRole("note")).not.toBeInTheDocument();
            expect(view.container.textContent).not.toMatch(/synthetic/i);
            view.unmount();
        }
    });

    it("renders the richer stages with varied visuals", () => {
        vi.stubEnv("VITE_CROSS_VENDOR_DEMO", "true");
        const { unmount } = render(<StageFilterContext.Provider value={pageStages("vendor-adoption")}><CrossVendorScreen /></StageFilterContext.Provider>);
        for (const label of ["Weekly active people by tool", "How many tools people use", "Usage by department", "Claude models", "ChatGPT / Codex models", "Cursor models"]) expect(screen.getByRole("figure", { name: label })).toBeInTheDocument();
        expect(screen.getAllByRole("row").length).toBeGreaterThan(10);
        unmount();
        const coding = render(<StageFilterContext.Provider value={pageStages("vendor-coding")}><CrossVendorScreen /></StageFilterContext.Provider>);
        expect(screen.getByText(/Acceptance rate isn't in this source/)).toBeInTheDocument();
        expect(screen.getByText("Tab accept rate")).toBeInTheDocument();
        coding.unmount();
        render(<StageFilterContext.Provider value={pageStages("vendor-spend")}><CrossVendorScreen /></StageFilterContext.Provider>);
        expect(screen.getByRole("figure", { name: "Microsoft 365 Copilot credits" })).toBeInTheDocument();
        expect(screen.getByText(/No cross-month or cross-currency total/)).toBeInTheDocument();
        expect(screen.queryByText(/USD.*credits total/i)).not.toBeInTheDocument();
    });

    it("retains cost precision and original source scope", () => {
        const cost = scopedMetrics(portfolio).find(m => m.unit === "currency")!;
        expect(metricValue(cost)).toBe("USD 1.25125");
        const chatgpt = scopedMetrics(portfolio, "openai_chatgpt", "ChatGPT")[0];
        expect(periodLabel(chatgpt.period)).toContain("inclusive dates; period only");
        expect(scopedMetrics(portfolio, "github_copilot")).toEqual([]);
    });
});
