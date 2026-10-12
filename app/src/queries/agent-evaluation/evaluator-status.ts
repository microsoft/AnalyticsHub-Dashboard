//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { QueryTable } from "@microsoft/fabric-app-data";
import { readNumber, readText, toRecords } from "@/lib/summary-row";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { evaluatorConnection as connection, FORMAT_WHOLE } from "../shared";
import query from "./evaluator-status.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Environment]": { name: "Environment", displayName: "Environment" },
    "[Lookback Days]": { name: "Lookback Days", displayName: "Days read", format: FORMAT_WHOLE },
    "[Transcripts]": { name: "Transcripts", displayName: "Transcripts", format: FORMAT_WHOLE },
    "[Status]": { name: "Status", displayName: "Status" },
};

/**
 * Which Dataverse environments the transcript parser read on its last run,
 * from the `Evaluator Status` table (dbo.evaluator_status), unfiltered. A
 * model without the table fails this query alone.
 */
export function evaluatorStatus() {
    return { connection, query, columnMetadata };
}

/** One environment the parser read: ok, empty, forbidden or error. */
export interface EvaluatorEnvironment {
    environment: string;
    /** How many days back it read; 0 for all time. */
    days: number;
    transcripts: number;
    status: string;
}

export function readEvaluatorStatus(table: QueryTable): EvaluatorEnvironment[] {
    return toRecords(table).flatMap((row) => {
        const environment = readText(row, "[Environment]");
        if (!environment) return [];
        return [
            {
                environment,
                days: readNumber(row, "[Lookback Days]") ?? 0,
                transcripts: readNumber(row, "[Transcripts]") ?? 0,
                status: readText(row, "[Status]")?.toLowerCase() ?? "",
            },
        ];
    });
}

export const ADD_ENVIRONMENTS =
    "To read other environments, run the installer, choose Repair or change, then Agent Evaluator, and tick the environments that hold your Copilot Studio agents. Copilot Studio usually keeps transcripts for 30 days, so older conversations can't be read.";

const names = (list: readonly EvaluatorEnvironment[]) => list.map((e) => e.environment).join(", ");
const span = (days: number) => (days > 0 ? `the last ${days} days` : "all the history it holds");

/**
 * Why the page is empty, from where the parser looked: "0 transcripts found
 * in Sales in the last 180 days", environments it wasn't allowed into, and how
 * to add others. Undefined when the parser hasn't recorded a run.
 */
export function describeEvaluatorStatus(
    environments: readonly EvaluatorEnvironment[] | undefined,
): { title: string; description: string } | undefined {
    if (!environments || environments.length === 0) return undefined;
    const sentences: string[] = [];
    const empty = environments.filter((e) => e.status === "empty" || (e.status === "ok" && e.transcripts === 0));
    const byDays = new Map<number, EvaluatorEnvironment[]>();
    for (const e of empty) byDays.set(e.days, [...(byDays.get(e.days) ?? []), e]);
    for (const [days, list] of byDays) sentences.push(`0 transcripts found in ${names(list)} in ${span(days)}.`);
    const forbidden = environments.filter((e) => e.status === "forbidden");
    if (forbidden.length > 0) {
        sentences.push(
            `The load wasn't allowed to read ${names(forbidden)}: the app that runs it needs to be an application user there with read access to conversation transcripts.`,
        );
    }
    const failed = environments.filter((e) => e.status === "error");
    if (failed.length > 0) sentences.push(`The load couldn't read ${names(failed)}. The transcript parser's run log has the error.`);
    const loaded = environments.filter((e) => e.status === "ok" && e.transcripts > 0);
    if (loaded.length > 0) {
        sentences.push(`${names(loaded)} had transcripts on the last load; they show here once the Agent Evaluator model refreshes.`);
    }
    sentences.push(ADD_ENVIRONMENTS);
    return { title: "No agent conversations found", description: sentences.join(" ") };
}
