//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BUSY_MESSAGE } from "@/lib/query-scheduler";
import { ErrorGroup, QueryError } from "./query-states";

describe("QueryError", () => {
    it("says Power BI is busy, rather than that the query broke, when it was throttled", () => {
        const onRetry = vi.fn();
        render(<QueryError message={BUSY_MESSAGE} onRetry={onRetry} />);

        expect(screen.getByText("Power BI is busy")).toBeTruthy();
        expect(screen.queryByText("This didn't load")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        expect(onRetry).toHaveBeenCalledOnce();
    });

    it("treats Power BI's own throttling text as busy too", () => {
        render(<QueryError message="Too many requests" />);

        expect(screen.getByText("Power BI is busy")).toBeTruthy();
        expect(screen.getByText("Too many requests")).toBeTruthy();
    });

    it("turns missing model columns into update guidance", () => {
        const message = "The column 'Agents 365'[Owner account] cannot be found or may not be used in this expression.";
        render(<QueryError message={message} />);

        expect(screen.getByText("Needs an update")).toBeTruthy();
        expect(screen.getByText("For your admin")).toBeTruthy();
        expect(screen.getByText(/Agents 365\[Owner account\]/)).toBeTruthy();
        expect(screen.getByText(message)).toBeTruthy();
    });

    it("says the data isn't loaded yet when the model was never refreshed", () => {
        const message =
            "Column 'Chat + Agent Interactions (Audit Logs)'[Is Usage Row] does not hold any data because it needs to be recalculated or refreshed.";
        render(<QueryError message={message} />);

        expect(screen.getByText("Data not loaded yet")).toBeTruthy();
        expect(screen.getByText(/choose\s+Repair or change/)).toBeTruthy();
        expect(screen.queryByText("This didn't load")).toBeNull();
        expect(screen.queryByText("Needs an update")).toBeNull();
    });

    it("keeps the raw error out of the way, behind Details", () => {
        render(<QueryError message="DAX comparison operations do not support comparing values of type Text" />);

        expect(screen.getByText("This didn't load")).toBeTruthy();
        expect(screen.getByText("Details").closest("details")?.open).toBe(false);
    });

    it("says a failure in full once per page, however many parts fail for the same reason", () => {
        render(
            <ErrorGroup>
                <QueryError message="Something broke" />
                <QueryError message="Something broke" />
                <QueryError message="Something else broke" />
            </ErrorGroup>,
        );

        expect(screen.getAllByRole("alert")).toHaveLength(2);
        expect(screen.getAllByText("This didn't load either, for the same reason.")).toHaveLength(1);
    });
});
