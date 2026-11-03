//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useStageFilter } from "@/hooks/stage-filter.context";
import { stageAnchor } from "@/components/destinations";
import { AdminSteps, QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { useSourceAvailability } from "@/hooks/source-availability.context";
import { useM365Activity } from "@/hooks/use-m365-activity";
import { M365_ACTIVITY_DESCRIPTION, M365_ACTIVITY_TITLE } from "./copy";
import { M365ActivityStage } from "./m365-activity-stage";
import { M365CopilotStage } from "./m365-copilot-stage";
import { M365SuiteStage } from "./m365-suite-stage";

/**
 * How people work across Microsoft 365, and where Copilot sits in that week.
 * The data is an optional installer module, so the page first checks it's
 * there and says how to switch it on, rather than showing a page of blanks.
 */
export function WorkPatternsScreen() {
    const activitySource = useSourceAvailability().m365Activity;
    if (activitySource === "notConfigured") return <M365NotConfigured />;
    return <WorkPatternsContent />;
}

function WorkPatternsContent() {
    const m365 = useM365Activity();
    const { show } = useStageFilter();

    if (m365.state === "ready") {
        return (
            <div className="flex flex-col gap-800">
                {show("m365-activity") && <M365ActivityStage concealed={m365.concealed} />}
                {show("m365-suite") && <M365SuiteStage />}
                {show("m365-copilot") && <M365CopilotStage concealed={m365.concealed} />}
            </div>
        );
    }

    return (
        <Section id={stageAnchor("m365-activity")} title={M365_ACTIVITY_TITLE} description={M365_ACTIVITY_DESCRIPTION}>
            {m365.state === "loading" ? (
                <div className="grid gap-300 md:grid-cols-2 xl:grid-cols-4">
                    <QueryLoading />
                    <QueryLoading />
                    <QueryLoading />
                    <QueryLoading />
                </div>
            ) : m365.state === "error" ? (
                <QueryError message={m365.error ?? "The semantic model didn't answer."} onRetry={m365.refetch} />
            ) : m365.state === "missing" ? (
                <QueryEmpty
                    title="Microsoft 365 activity isn't set up"
                    description={
                        <>
                            <p>This install predates Microsoft 365 activity, so there's nothing to show yet.</p>
                            <AdminSteps>
                                <p>
                                    Update the install to add Microsoft 365 activity. The page fills in after the next
                                    pipeline run.
                                </p>
                            </AdminSteps>
                        </>
                    }
                />
            ) : (
                <QueryEmpty
                    title="No Microsoft 365 activity yet"
                    description={
                        <>
                            <p>
                                Either it's switched off or it hasn't loaded yet. The usage reports run two to three
                                days behind.
                            </p>
                            <AdminSteps>
                                <p>
                                    To switch it on, run the installer again and tick Microsoft 365 activity. It needs
                                    the Reports.Read.All permission.
                                </p>
                            </AdminSteps>
                        </>
                    }
                />
            )}
        </Section>
    );
}

function M365NotConfigured() {
    return (
        <Section id={stageAnchor("m365-activity")} title={M365_ACTIVITY_TITLE} description={M365_ACTIVITY_DESCRIPTION}>
            <QueryEmpty
                title="Microsoft 365 activity isn't turned on"
                description={
                    <>
                        <p>Microsoft 365 activity is an optional source that isn't connected.</p>
                        <AdminSteps>
                            <p>
                                Run the installer again and tick Microsoft 365 activity. It needs Reports.Read.All, and
                                the page fills in after the next load and model refresh.
                            </p>
                        </AdminSteps>
                    </>
                }
            />
        </Section>
    );
}
