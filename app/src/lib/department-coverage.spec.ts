//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { coverageNote, departmentCoverage, DEPARTMENT_ADVICE, orgEmptyDescription } from "./department-coverage";
import { describeOrgAttribute } from "./org-attribute";

const ORG = describeOrgAttribute("Organization");
const BASE = "Nobody in the current selection has a license or a task with organization recorded.";

describe("departmentCoverage", () => {
    it("says how many people with a task have a department", () => {
        const coverage = departmentCoverage(180, 200, "Organization");
        expect(coverage).toMatchObject({ have: 180, people: 200, low: false });
        expect(coverage?.text).toBe("180 of 200 people with a task have a department");
        expect(coverageNote(coverage!)).toBe(coverage?.text);
    });

    it("flags low coverage and says how to fill the gaps", () => {
        const coverage = departmentCoverage(30, 200, "Organization");
        expect(coverage?.low).toBe(true);
        const note = coverageNote(coverage!);
        expect(note).toContain("30 of 200 people with a task have a department.");
        expect(note).toContain("Fill in Department on users in Microsoft Entra ID");
        expect(note).toContain("Workday org data");
    });

    it("has nothing to say without counts, or for another org attribute", () => {
        expect(departmentCoverage(undefined, 200, "Organization")).toBeUndefined();
        expect(departmentCoverage(10, 0, "Organization")).toBeUndefined();
        expect(departmentCoverage(10, 20, "officeLocation")).toBeUndefined();
    });
});

describe("orgEmptyDescription", () => {
    it("adds the coverage and advice to an empty by-organization view", () => {
        const text = orgEmptyDescription(BASE, ORG, departmentCoverage(0, 200, "Organization"));
        expect(text).toBe(`${BASE} 0 of 200 people with a task have a department. ${DEPARTMENT_ADVICE}`);
    });

    it("keeps the advice out when most people have a department", () => {
        expect(orgEmptyDescription(BASE, ORG, departmentCoverage(190, 200, "Organization"))).toBe(
            `${BASE} 190 of 200 people with a task have a department.`,
        );
    });

    it("says where the department comes from when there is no count", () => {
        const text = orgEmptyDescription(BASE, ORG);
        expect(text.startsWith(BASE)).toBe(true);
        expect(text).toContain("Department in Microsoft Entra ID");
        expect(text).toContain("Repair or change");
    });

    it("leaves other org attributes alone", () => {
        expect(orgEmptyDescription(BASE, describeOrgAttribute("officeLocation"))).toBe(BASE);
    });
});
