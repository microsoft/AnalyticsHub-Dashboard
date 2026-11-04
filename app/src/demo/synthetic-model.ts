import type { CachedQueryResult } from "@microsoft/fabric-app-data";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { sampleConsumptionRows } from "./sample-consumption";
import { sampleQueryRows } from "./sample-model";

type DemoQueryTable = Extract<CachedQueryResult, { status: "success" }>["table"];

/** Source-backed offline query adapter. Unknown queries fail visibly instead of inventing data. */
export function syntheticQueryResult(query: string, metadata?: ColumnMetadataMap): CachedQueryResult {
    const columns = queryColumns(query, metadata);
    if (/"Part"\s*,\s*"[^"]+"/.test(query) && !columns.includes("[Part]")) columns.push("[Part]");
    const rows = sampleConsumptionRows(query, columns) ?? sampleQueryRows(query, columns);
    if (rows === undefined) return {
        status: "error", error: { category: "query", message: `This view is not available in the published synthetic sample pack (${columns.join(", ")}).` },
        requestId: "offline-samples", fromCache: false,
    };
    const table: DemoQueryTable = {
        columns: columns.map((name, index) => {
            const value = rows.find(row => row[index] !== null && row[index] !== undefined)?.[index];
            return { name, dataType: typeof value === "number" ? "Double" : typeof value === "boolean" ? "Boolean"
                : typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? "DateTime" : "String" };
        }),
        rows,
    };
    return { status: "success", table, requestId: "offline-samples", fromCache: false };
}

function queryColumns(query: string, metadata?: ColumnMetadataMap): string[] {
    const declared = Object.keys(metadata ?? {});
    if (declared.length) return declared;
    if (query.includes('"Cardinality"')) return ["[Column]", "[Cardinality]", ...(query.includes('"Max Length"') ? ["[Max Length]"] : [])];
    if (query.includes('"Kind"') && query.includes('"Value"')) return query.includes('"Sort"') ? ["[Kind]", "[Value]", "[Sort]"] : ["[Kind]", "[Value]"];
    if (query.includes('"Attribute"')) return ["[Attribute]"];
    if (query.includes('"Value"')) return ["[Value]"];
    const clean = query.replace(/\/\/[^\r\n]*/g, "").replace(/^[ \t]*--[^\r\n]*/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const select = [...clean.matchAll(/\bSELECTCOLUMNS\s*\(/gi)].at(-1);
    if (select?.index !== undefined) {
        const args = splitDaxArguments(clean, clean.indexOf("(", select.index) + 1);
        const aliases = args.slice(1).filter((_, index) => index % 2 === 0)
            .map(argument => /^"((?:[^"]|"")*)"$/.exec(argument.trim())?.[1].replace(/""/g, '"'))
            .filter((name): name is string => name !== undefined);
        if (aliases.length) return aliases.map(name => name.startsWith("[") ? name : `[${name}]`);
    }
    const row = [...clean.matchAll(/\bROW\s*\(/gi)].at(-1);
    if (row?.index !== undefined) {
        const aliases = [...clean.slice(row.index).matchAll(/"([^"]+)"\s*,/g)].map(match => match[1])
            .filter((name, index, all) => all.indexOf(name) === index);
        if (aliases.length) return aliases.map(name => name.startsWith("[") ? name : `[${name}]`);
    }
    const call = /\bSUMMARIZECOLUMNS\s*\(/i.exec(clean);
    if (call?.index === undefined) return [];
    const args = splitDaxArguments(clean, clean.indexOf("(", call.index) + 1);
    const result: string[] = [];
    let measures = false;
    for (const argument of args.map(value => value.trim())) {
        const group = /^(?:'([^']+)'|([A-Za-z_][\w ]*))\[([^\]]+)\]$/.exec(argument);
        if (!measures && group) result.push(`${group[1] ?? group[2]}[${group[3]}]`);
        else {
            const alias = /^"((?:[^"]|"")*)"$/.exec(argument);
            if (alias) { measures = true; result.push(`[${alias[1].replace(/""/g, '"')}]`); }
        }
    }
    return result;
}

function splitDaxArguments(query: string, start: number): string[] {
    const args: string[] = [];
    let depth = 0;
    let inString = false;
    let argumentStart = start;
    for (let index = start; index < query.length; index++) {
        const character = query[index];
        if (character === '"') {
            if (inString && query[index + 1] === '"') index++;
            else inString = !inString;
        } else if (!inString && character === "(") depth++;
        else if (!inString && character === ")") {
            if (depth === 0) { args.push(query.slice(argumentStart, index)); return args; }
            depth--;
        } else if (!inString && character === "," && depth === 0) {
            args.push(query.slice(argumentStart, index)); argumentStart = index + 1;
        }
    }
    return [];
}
