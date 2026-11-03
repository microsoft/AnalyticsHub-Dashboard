//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { useCssTheme } from "@microsoft/fabric-visuals";
import App from "@/App";
import { ThemeContext } from "@/hooks/theme.context";
import { useAppTheme } from "@/hooks/use-theme";

/** Mirrors the provider chain `main.tsx` mounts around the app. */
function Harness({ children }: { children: ReactNode }) {
    const { isDark, toggleTheme } = useAppTheme();
    const theme = useCssTheme();
    return (
        <ThemeContext.Provider value={{ isDark, toggleTheme, theme }}>{children}</ThemeContext.Provider>
    );
}

describe("App", () => {
    it("renders without throwing", () => {
        expect(() =>
            render(
                <Harness>
                    <App />
                </Harness>,
            ),
        ).not.toThrow();
    });

    it("mounts content into the document", () => {
        render(
            <Harness>
                <App />
            </Harness>,
        );
        expect(document.body).not.toBeEmptyDOMElement();
    });

    it("credits its creator at the foot of the sidebar, linking to his profile in a new tab", () => {
        render(
            <Harness>
                <App />
            </Harness>,
        );
        const sidebar = screen.getByRole("navigation", { name: "Sections" });
        const link = within(sidebar).getByRole("link", { name: "Keith McGrane" });
        const footer = link.closest("footer");

        expect(footer).toHaveTextContent(/^Created by Keith McGrane$/);
        expect(sidebar.lastElementChild).toBe(footer);
        expect(link).toHaveAttribute("href", "https://github.com/Keithland89");
        expect(link).toHaveAttribute("target", "_blank");
        expect(link).toHaveAttribute("rel", "noreferrer");
    });

    it("opens the view a link names, and keeps it in the URL", () => {
        window.history.replaceState(null, "", "/#/value");
        render(
            <Harness>
                <App />
            </Harness>,
        );
        const sidebar = screen.getByRole("navigation", { name: "Sections" });
        expect(within(sidebar).getByRole("link", { name: "Value" })).toHaveAttribute("aria-current", "page");
        expect(window.location.hash).toMatch(/^#\/value/);
    });

    it("puts each view in the history, so Back returns to the last one", async () => {
        render(
            <Harness>
                <App />
            </Harness>,
        );
        const sidebar = screen.getByRole("navigation", { name: "Sections" });
        fireEvent.click(within(sidebar).getByRole("link", { name: "Adoption" }));
        expect(window.location.hash).toMatch(/^#\/adoption/);
        fireEvent.click(within(sidebar).getByRole("link", { name: "Value" }));
        expect(window.location.hash).toMatch(/^#\/value/);

        window.history.back();
        await waitFor(() => expect(within(sidebar).getByRole("link", { name: "Adoption" })).toHaveAttribute("aria-current", "page"));
        expect(window.location.hash).toMatch(/^#\/adoption/);
    });
});
