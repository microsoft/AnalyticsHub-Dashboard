//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useRef, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import type { StageId } from "./destinations";

interface StageTabsProps {
    /** Names the tab list for assistive technology, e.g. "Adoption stages". */
    label: string;
    stages: readonly { id: StageId; label: string }[];
    open: StageId | undefined;
    onOpen: (stage: StageId) => void;
}

const KEYS: Record<string, (index: number, count: number) => number> = {
    ArrowRight: (index, count) => (index + 1) % count,
    ArrowLeft: (index, count) => (index - 1 + count) % count,
    Home: () => 0,
    End: (_, count) => count - 1,
};

/**
 * A page's stages as tabs. A page shows one stage at a time, so it only
 * queries what is open; the sidebar lists the same stages.
 */
export function StageTabs({ label, stages, open, onOpen }: StageTabsProps) {
    const refs = useRef<(HTMLButtonElement | null)[]>([]);

    const onKeyDown = (event: KeyboardEvent, index: number) => {
        const move = KEYS[event.key];
        if (!move) return;
        event.preventDefault();
        const next = move(index, stages.length);
        refs.current[next]?.focus();
        onOpen(stages[next].id);
    };

    return (
        <div role="tablist" aria-label={label} data-print="hide" className="-mb-300 flex flex-wrap gap-100 border-b border-border">
            {stages.map((stage, index) => {
                const selected = stage.id === open;
                return (
                    <button
                        key={stage.id}
                        ref={(element) => {
                            refs.current[index] = element;
                        }}
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        tabIndex={selected ? 0 : -1}
                        onClick={() => onOpen(stage.id)}
                        onKeyDown={(event) => onKeyDown(event, index)}
                        className={cn(
                            "-mb-px border-b-2 px-300 py-200 text-[length:var(--text-300)] leading-300 transition-colors",
                            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                            selected
                                ? "border-primary font-semibold text-foreground"
                                : "border-transparent text-muted-foreground hover:text-foreground",
                        )}
                    >
                        {stage.label}
                    </button>
                );
            })}
        </div>
    );
}
