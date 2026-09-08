#!/usr/bin/env bun

/**
 * @description Runs the portable work-contract CLI without adding execution-runtime authority.
 *
 * @module work/bin
 * @file Work.ts
 */

import { runWorkContractCli } from '../src/cli'

const main = async (): Promise<void> => {
	process.exitCode = await runWorkContractCli(process.argv.slice(2))
}

void main()
