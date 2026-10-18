#!/usr/bin/env node

//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------


// Sets up Analytics Hub as a Copilot managed app, or updates it:
//
//   npm run deploy:managed
//   npm run deploy:managed -- --help
//
// The steps live in installer/src/managed-app, so the installer runs the same
// ones. See docs/MANAGED-APP.md.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDeploy, terminalIo } from '../../installer/src/managed-app/flow.js';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const io = terminalIo();
try {
    process.exitCode = await runDeploy(process.argv.slice(2), { io, appDir });
} finally {
    io.close?.();
}
