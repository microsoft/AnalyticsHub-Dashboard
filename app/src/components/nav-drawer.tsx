//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface NavDrawerProps {
    open: boolean;
    onClose: () => void;
    /** Where focus goes back to when the menu closes. */
    returnFocus: RefObject<HTMLElement | null>;
    children: ReactNode;
}

/**
 * The sidebar on a narrow screen: a menu that slides over the page. It holds
 * focus while open, and closes on Escape, on the backdrop, or from its button.
 */
export function NavDrawer({ open, onClose, returnFocus, children }: NavDrawerProps) {
    const panelRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const panel = panelRef.current;
        panel?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
        const target = returnFocus.current;
        return () => target?.focus();
    }, [open, returnFocus]);

    if (!open) return null;

    const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
            return;
        }
        if (event.key !== "Tab" || !panelRef.current) return;
        const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    };

    return (
        <div className="fixed inset-0 z-40" data-print="hide">
            <div className="absolute inset-0 bg-black/40" aria-hidden="true" onClick={onClose} />
            <div
                ref={panelRef}
                id="sections-menu"
                role="dialog"
                aria-modal="true"
                aria-label="Menu"
                onKeyDown={onKeyDown}
                className="absolute inset-y-0 left-0 flex w-[min(300px,85vw)] flex-col gap-500 overflow-y-auto border-r border-border bg-card px-400 py-400 shadow-lg"
            >
                <div className="flex items-center justify-between gap-200 px-200">
                    <span className="text-[length:var(--text-500)] leading-500 font-semibold">Analytics Hub</span>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close menu"
                        className="flex size-[44px] items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                        <X className="icon-size-300" aria-hidden="true" />
                    </button>
                </div>
                <nav aria-label="Sections" className="flex flex-1 flex-col gap-500">
                    {children}
                </nav>
            </div>
        </div>
    );
}
