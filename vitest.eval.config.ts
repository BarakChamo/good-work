/**
 * @description Configures deterministic tests for non-shipped evaluation drivers.
 *
 * @module work/vitest-eval
 * @file Vitest.eval.config.ts
 */

import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		environment: 'node',
		exclude: ['**/node_modules/**', '**/.git/**', '**/*.int.test.ts'],
		include: ['evals/**/*.test.ts'],
		testTimeout: 30_000,
	},
})
