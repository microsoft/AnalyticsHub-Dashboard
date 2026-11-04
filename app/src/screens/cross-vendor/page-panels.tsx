import type { ReactNode } from "react";
import { OpenDestinationLink } from "@/components/open-destination-link";
import { Section } from "@/components/section";
import type { StageId } from "@/components/destinations";
import { runtimeConfig } from "@/lib/runtime-config";
import { AllToolsSummary, CreditsVsSpend, LeadersTable, MultiToolCharts, TaskMixHeatmap } from "./insights";

export type CrossVendorPage = "executive" | "adoption" | "consumption" | "efficiency" | "leaderboards";

const panels: Record<CrossVendorPage, { title: string; description: string; stage: StageId; link: string; body: () => ReactNode }> = {
    executive: { title: "All AI tools", description: "Copilot alongside Claude, ChatGPT / Codex and Cursor. Each tool's active people are counted separately, so they aren't added together.", stage: "vendor-portfolio", link: "Open the Cross-vendor view", body: () => <AllToolsSummary /> },
    adoption: { title: "People using more than one AI tool", description: "How many tools people use, and which tools Copilot users pair with.", stage: "vendor-adoption", link: "See adoption trends across tools", body: () => <MultiToolCharts /> },
    consumption: { title: "Copilot credits beside other AI tools' spend", description: "Credits and USD charges are different units, so they sit side by side and are never added.", stage: "vendor-spend", link: "See spend and credits by tool", body: () => <CreditsVsSpend /> },
    efficiency: { title: "Which tool people use for which task", description: "Tasks come from each tool's native product or app, mapped as described in the Cross-vendor view's Methodology.", stage: "vendor-portfolio", link: "Open the Cross-vendor view", body: () => <TaskMixHeatmap /> },
    leaderboards: { title: "Most active people across AI tools", description: "Ranked by how many tools each person used, then by days active in the daily-cadence tools.", stage: "vendor-adoption", link: "See adoption trends across tools", body: () => <LeadersTable /> },
};

export default function CrossVendorPagePanel({ page }: { page: CrossVendorPage }) {
    const panel = panels[page];
    return (
        <div data-provenance="synthetic" data-cross-vendor-panel={page} data-print="hide">
            <Section title={panel.title} description={`${panel.description}${runtimeConfig().demo ? " Separate synthetic comparison scenario, not the published CSV cohort on this page." : ""}`} actions={<OpenDestinationLink destination="cross-vendor" stage={panel.stage}>{panel.link}</OpenDestinationLink>}>
                {panel.body()}
            </Section>
        </div>
    );
}
