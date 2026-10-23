//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/**
 * The report's Leaderboard bookmarks, which the session concentration on
 * Adoption ranks. Unlike the Work cohorts they count sessions rather than
 * tasks, and add Cowork: sessions in the Cowork surface.
 */
export type LeaderboardCohort = "all" | "licensed" | "unlicensed" | "agents" | "cowork";

/** The measures one cohort's tables and cards bind to, as the report binds them. */
export interface LeaderboardMeasures {
    users: string;
    sessions: string;
    perUser: string;
    perWeek: string;
}

interface CohortDefinition {
    id: LeaderboardCohort;
    label: string;
    measures: LeaderboardMeasures;
}

const definitions: readonly CohortDefinition[] = [
    {
        id: "all",
        label: "Everyone",
        measures: {
            users: "All Active Users",
            sessions: "Observed Sessions",
            perUser: "Observed Sessions per User",
            perWeek: "Observed Sessions per User per Week",
        },
    },
    {
        id: "licensed",
        label: "Licensed",
        measures: {
            users: "Active Licensed Users",
            sessions: "Observed Licensed Sessions",
            perUser: "Observed Licensed Sessions per User",
            perWeek: "Observed Licensed Sessions per User per Week",
        },
    },
    {
        id: "unlicensed",
        label: "Unlicensed",
        measures: {
            users: "Active Unlicensed Users",
            sessions: "Observed Unlicensed Sessions",
            perUser: "Observed Unlicensed Sessions per User",
            perWeek: "Observed Unlicensed Sessions per User per Week",
        },
    },
    {
        id: "agents",
        label: "Agents",
        measures: {
            users: "Active Agent Users",
            sessions: "Observed Agent Sessions",
            perUser: "Observed Agent Sessions per User",
            perWeek: "Observed Agent Sessions per User per Week",
        },
    },
    {
        id: "cowork",
        label: "Cowork",
        measures: {
            users: "Cowork Users",
            sessions: "Observed Cowork Sessions",
            perUser: "Observed Cowork Sessions per User",
            perWeek: "Observed Cowork Sessions per User per Week",
        },
    },
];

const byId = new Map(definitions.map((definition) => [definition.id, definition]));

function definition(cohort: LeaderboardCohort): CohortDefinition {
    const found = byId.get(cohort);
    if (!found) throw new Error(`Unknown leaderboard cohort "${cohort}".`);
    return found;
}

/** The five leaderboard cohorts, in reading order. */
export const leaderboardCohorts: { id: LeaderboardCohort; label: string }[] = definitions.map(({ id, label }) => ({
    id,
    label,
}));

export function leaderboardMeasures(cohort: LeaderboardCohort): LeaderboardMeasures {
    return definition(cohort).measures;
}

/**
 * Fills a leaderboard query template's measure placeholders with one
 * cohort's measures.
 */
export function withCohortMeasures(template: string, cohort: LeaderboardCohort): string {
    const measures = leaderboardMeasures(cohort);
    return template
        .replaceAll("__USERS__", measures.users)
        .replaceAll("__SESSIONS__", measures.sessions)
        .replaceAll("__PER_WEEK__", measures.perWeek);
}
