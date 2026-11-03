//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { FilterContext } from "@/hooks/filter.context";
import { useSemanticModelQuery, useSpeculativeQuery } from "@/hooks/use-semantic-model-query";
import { isConnectionConfigured } from "@/lib/connections";
import { tenantDefaultFilters, type FilterKey, type FilterState } from "@/lib/filters";
import { DEFAULT_ORG_ATTRIBUTE, describeOrgAttribute } from "@/lib/org-attribute";
import { runtimeConfig } from "@/lib/runtime-config";
import {
    consumptionOrgAttributeOptions,
    filterOptions,
    orgAttributeOptions,
    orgValueOptions,
    toConsumptionOrgAttributes,
    toFilterOptions,
    toOrgAttributes,
    toOrgValues,
} from "@/queries/filters";
import { consumptionConnection, evaluatorConnection } from "@/queries/shared";

const optionsConfig = filterOptions();
const attributesConfig = orgAttributeOptions();
const FALLBACK_ATTRIBUTES = [DEFAULT_ORG_ATTRIBUTE];
const NONE: readonly string[] = [];

function consumptionConfigured(): boolean {
    return isConnectionConfigured(runtimeConfig().semanticModels, consumptionConnection);
}

const consumptionAttributes = consumptionOrgAttributeOptions();
const evaluatorAttributes = orgAttributeOptions(evaluatorConnection);
const NO_QUERY = { connection: consumptionConnection, query: "" };

/** Asks Consumption Central only when the app is connected to it. */
function consumptionAttributesConfig() {
    return consumptionConfigured() ? consumptionAttributes : NO_QUERY;
}

/**
 * Holds the filter bar's state for the whole app and loads its choices once.
 * `applicable` changes with the destination; the state itself does not, so a
 * filter set on one destination is still set on the next.
 *
 * The org attribute is resolved here rather than stored resolved: a choice
 * the model does not have — or the default, on a model whose `Organization`
 * column is empty — falls back to the first column worth grouping by.
 *
 * Every session starts on the tenant's default dates — the last 12 weeks on a
 * large tenant, every date on a small one — which each query works out for
 * itself, so the page's first queries don't wait for the options.
 *
 * Only the filter options load with the page. The org columns load in the
 * background lane, and on screen once a breakdown by org or a filter menu
 * other than the dates asks for them. What only a menu shows — the org
 * values, and Consumption Central's org attributes — loads when one first
 * opens; the attributes also load once an org filter is set.
 *
 * The org values are offered once the org columns have settled which column
 * is in use, so a menu never offers one column's values under another's name.
 * Until then the values of the column in use now load beside them: it seldom
 * changes, so a menu opened early waits for the slower of the two, not both.
 */
export function FilterProvider({
    applicable,
    initial,
    children,
}: {
    applicable: readonly FilterKey[];
    /** The filters to start with, such as those a link carried; the tenant's defaults otherwise. */
    initial?: FilterState;
    children: ReactNode;
}) {
    // The tenant's default date window from the first query: each query decides in the model whether it narrows.
    const [state, setFilters] = useState<FilterState>(initial ?? tenantDefaultFilters);
    const [menuOpened, setMenuOpened] = useState(false);
    const [orgColumnsWanted, setOrgColumnsWanted] = useState(false);
    const requestFilterChoices = useCallback(() => setMenuOpened(true), []);
    const requestOrgAttributes = useCallback(() => setOrgColumnsWanted(true), []);
    const { data, error, refetch: retryFilterOptions } = useSemanticModelQuery(optionsConfig);
    const attributesResult = useSemanticModelQuery({ ...attributesConfig, background: !(menuOpened || orgColumnsWanted) });
    const candidates = useMemo(
        () => attributesResult.data?.status === "success" ? toOrgAttributes(attributesResult.data.table) : NONE,
        [attributesResult.data],
    );
    const columnsSettled = attributesResult.error !== undefined || attributesResult.data !== undefined;

    const options = useMemo(() => (data?.status === "success" ? toFilterOptions(data.table) : undefined), [data]);

    const orgAttributes = useMemo(() => {
        if (attributesResult.data?.status === "success") return candidates;
        if (attributesResult.error) return NONE;
        return FALLBACK_ATTRIBUTES;
    }, [attributesResult.data, attributesResult.error, candidates]);

    const resolvedColumn = orgAttributes.includes(state.orgAttribute) ? state.orgAttribute : orgAttributes[0] ?? DEFAULT_ORG_ATTRIBUTE;
    const orgAttribute = useMemo(() => describeOrgAttribute(resolvedColumn), [resolvedColumn]);

    const values = useMemo(() => orgValueOptions(orgAttribute), [orgAttribute]);
    const valuesResult = useSemanticModelQuery(menuOpened && columnsSettled ? values : { ...values, query: "" });
    // After the query above, which then joins this one where it waits or reads its answer.
    useSpeculativeQuery(menuOpened && !columnsSettled ? values : { ...values, query: "" });
    // While the values load, those held are the last column's, if any.
    const orgValues = useMemo(
        () =>
            valuesResult.data?.status === "success" && !valuesResult.isLoading
                ? toOrgValues(valuesResult.data.table)
                : undefined,
        [valuesResult.data, valuesResult.isLoading],
    );

    const filters = useMemo(
        () => (state.orgAttribute === resolvedColumn ? state : { ...state, orgAttribute: resolvedColumn, organizations: [] }),
        [state, resolvedColumn],
    );

    const consumptionWanted = menuOpened || state.organizations.length > 0;
    const consumptionResult = useSemanticModelQuery(consumptionWanted ? consumptionAttributesConfig() : NO_QUERY);
    const consumptionOrgAttributes = useMemo(() => {
        if (!consumptionConfigured()) return NONE;
        if (consumptionResult.data?.status === "success") return toConsumptionOrgAttributes(consumptionResult.data.table);
        return consumptionResult.data?.status === "error" ? NONE : undefined;
    }, [consumptionResult.data]);

    const evaluatorConfigured = isConnectionConfigured(runtimeConfig().semanticModels, evaluatorConnection);
    const evaluatorResult = useSemanticModelQuery(
        evaluatorConfigured && state.organizations.length > 0
            ? evaluatorAttributes
            : { ...evaluatorAttributes, query: "" },
    );
    const evaluatorOrgAttributes = useMemo(() => {
        if (!evaluatorConfigured) return NONE;
        if (evaluatorResult.data?.status === "success") return toOrgAttributes(evaluatorResult.data.table);
        return evaluatorResult.error ? NONE : undefined;
    }, [evaluatorConfigured, evaluatorResult.data, evaluatorResult.error]);
    const optionsError = error ?? attributesResult.error ?? valuesResult.error ??
        consumptionResult.error ?? evaluatorResult.error;
    const retryAttributes = attributesResult.refetch;
    const retryValues = valuesResult.refetch;
    const retryConsumption = consumptionResult.refetch;
    const retryEvaluator = evaluatorResult.refetch;
    const retryOptions = useCallback(() => {
        retryFilterOptions();
        retryAttributes();
        retryValues();
        retryConsumption();
        retryEvaluator();
    }, [retryFilterOptions, retryAttributes, retryValues, retryConsumption, retryEvaluator]);

    const value = useMemo(
        () => ({
            filters,
            setFilters,
            options,
            optionsError,
            retryOptions,
            applicable,
            orgAttribute,
            orgAttributes,
            orgValues,
            consumptionOrgAttributes,
            evaluatorOrgAttributes,
            requestFilterChoices,
            requestOrgAttributes,
        }),
        [
            filters,
            options,
            optionsError,
            retryOptions,
            applicable,
            orgAttribute,
            orgAttributes,
            orgValues,
            consumptionOrgAttributes,
            evaluatorOrgAttributes,
            requestFilterChoices,
            requestOrgAttributes,
        ],
    );

    return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
}
