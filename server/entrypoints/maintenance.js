/** P2-D explicit, short-lived maintenance process. */

import 'dotenv/config';

import { runMaintenanceCli } from '../maintenance/cli.js';

const result = await runMaintenanceCli();
process.exitCode = result.exitCode;
