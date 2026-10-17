#!/usr/bin/env node

//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------


// Checks a build for Copilot Managed App code. Shared code imports managed-only
// modules but uses them only when import.meta.env.MODE is "managed", so every
// other build should drop them.
//
//   node scripts/check-managed-markers.mjs dist absent    fails if any marker is in the build
//   node scripts/check-managed-markers.mjs dist present   fails if any marker is missing
//
// CI runs "absent" on the Fabric build and "present" on the managed build, so a
// marker that goes stale fails too.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// Text from each managed-only module that shared code imports, and the Managed
// Runtime SDK. managed-auth-gate.tsx renders the Diagnostics panel, and
// managed-config.ts has no text of its own.
const MARKERS = [
    ['Copilot Managed App diagnostics', 'src/components/managed-diagnostics-panel.tsx'],
    ['The Managed Runtime host', 'src/services/managed-auth.service.ts'],
    ['Arrow DAX is not supported on the Managed Runtime', 'src/lib/managed/managed-runtime-proxy.ts'],
    ['ExecuteDatasetQueriesJson', 'src/lib/managed/connector-operations.ts'],
    ['analytics-hub:managed:probe', 'src/lib/managed/browser-storage.ts'],
    ['@microsoft/managed-apps', 'the Managed Runtime SDK'],
];

const [dir, expect] = process.argv.slice(2);
if (!dir || !['absent', 'present'].includes(expect)) {
    console.error('Usage: node scripts/check-managed-markers.mjs <build folder> absent|present');
    process.exit(2);
}
if (!existsSync(join(dir, 'index.html'))) {
    console.error(`${dir} isn't a build: it has no index.html.`);
    process.exit(2);
}

function* files(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) yield* files(path);
        else if (entry.isFile()) yield path;
    }
}

const found = new Map(MARKERS.map(([marker]) => [marker, []]));
let count = 0;
for (const file of files(dir)) {
    count++;
    const bytes = readFileSync(file);
    for (const [marker, where] of found) {
        if (bytes.includes(marker)) where.push(relative(dir, file).replaceAll('\\', '/'));
    }
}

if (expect === 'absent') {
    const leaks = MARKERS.filter(([marker]) => found.get(marker).length > 0);
    if (leaks.length > 0) {
        console.error(`Copilot Managed App code is in ${dir}:`);
        for (const [marker, source] of leaks) console.error(`  "${marker}" (${source}) in ${found.get(marker).join(', ')}`);
        console.error('Use managed-only code only when import.meta.env.MODE is "managed", so other builds drop it.');
        process.exit(1);
    }
    console.log(`No Copilot Managed App code in ${dir}: none of ${MARKERS.length} markers in ${count} files.`);
} else {
    const missing = MARKERS.filter(([marker]) => found.get(marker).length === 0);
    if (missing.length > 0) {
        console.error(`The managed build in ${dir} is missing markers:`);
        for (const [marker, source] of missing) console.error(`  "${marker}" (${source})`);
        console.error('Update MARKERS in scripts/check-managed-markers.mjs to text those modules still have.');
        process.exit(1);
    }
    console.log(`All ${MARKERS.length} Copilot Managed App markers are in ${dir}.`);
}
