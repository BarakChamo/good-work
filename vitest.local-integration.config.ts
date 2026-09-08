/**
 * @description Configures serialized local Beads and Git integration tests.
 *
 * @module work/vitest-local-integration
 * @file Vitest.local-integration.config.ts
 */

import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		environment: 'node',
		exclude: ['**/node_modules/**', '**/.git/**'],
		fileParallelism: false,
		include: ['src/**/*.int.test.ts', 'evals/**/*.int.test.ts'],
		maxWorkers: 1,
		pool: 'forks',
		reporters: ['dot'],
		silent: 'passed-only',
		testTimeout: 120_000,
	},
})
