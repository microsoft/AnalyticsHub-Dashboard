#!/usr/bin/env node

//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------


// Deletes the Copilot managed app that deploy:managed set up. It asks first:
//
//   npm run remove:managed
//
// See docs/MANAGED-APP.md.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRemove, terminalIo } from '../../installer/src/managed-app/flow.js';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const io = terminalIo();
try {
    process.exitCode = await runRemove(process.argv.slice(2), { io, appDir });
} finally {
    io.close?.();
}
