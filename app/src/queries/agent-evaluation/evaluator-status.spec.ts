//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { ADD_ENVIRONMENTS, describeEvaluatorStatus, evaluatorStatus, readEvaluatorStatus } from "./index";

describe("evaluator status query", () => {
    it("reads the Evaluator Status table on the Agent Evaluator model", () => {
        const { connection, query, columnMetadata } = evaluatorStatus();
        expect(connection).toBe("ae");
        expect(query.trim()).toMatch(/^EVALUATE\b/);
        for (const column of ["Environment", "LookbackDays", "Transcripts", "Status"]) {
            expect(query).toContain(`'Evaluator Status'[${column}]`);
        }
        expect(Object.keys(columnMetadata).sort()).toEqual(["[Environment]", "[Lookback Days]", "[Status]", "[Transcripts]"]);
    });

    it("reads its rows by column name, skipping rows without an environment", () => {
        const table = {
            columns: [{ name: "[Status]" }, { name: "[Environment]" }, { name: "[Transcripts]" }, { name: "[Lookback Days]" }],
            rows: [
                ["Empty", "Sales", 0, 180],
                ["ok", null, 3, 14],
            ],
        };
        expect(readEvaluatorStatus(table as never)).toEqual([{ environment: "Sales", days: 180, transcripts: 0, status: "empty" }]);
    });
});

describe("describeEvaluatorStatus", () => {
    it("says how many transcripts it found where, over how long, and how to add environments", () => {
        const why = describeEvaluatorStatus([
            { environment: "Contoso (default)", days: 180, transcripts: 0, status: "empty" },
            { environment: "Sales", days: 180, transcripts: 0, status: "empty" },
        ]);
        expect(why?.title).toBe("No agent conversations found");
        expect(why?.description).toBe(`0 transcripts found in Contoso (default), Sales in the last 180 days. ${ADD_ENVIRONMENTS}`);
        expect(ADD_ENVIRONMENTS).toContain("Repair or change");
    });

    it("names environments it wasn't allowed into, couldn't read, or that loaded since the refresh", () => {
        const why = describeEvaluatorStatus([
            { environment: "Sales", days: 14, transcripts: 0, status: "empty" },
            { environment: "HR", days: 180, transcripts: 0, status: "forbidden" },
            { environment: "Finance", days: 180, transcripts: 0, status: "error" },
            { environment: "Support", days: 0, transcripts: 12, status: "ok" },
        ])?.description;
        expect(why).toContain("0 transcripts found in Sales in the last 14 days.");
        expect(why).toContain("The load wasn't allowed to read HR");
        expect(why).toContain("The load couldn't read Finance.");
        expect(why).toContain("Support had transcripts on the last load");
    });

    it("says nothing more when the parser hasn't recorded a run", () => {
        expect(describeEvaluatorStatus(undefined)).toBeUndefined();
        expect(describeEvaluatorStatus([])).toBeUndefined();
    });
});
