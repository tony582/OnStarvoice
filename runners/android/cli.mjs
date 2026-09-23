#!/usr/bin/env node
// Keep this executable free of configuration and domain logic.
import {runCli} from './src/cli/index.mjs';
process.exitCode = await runCli(process.argv.slice(2));
