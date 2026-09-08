/**
 * @description Configures isolated unit tests for the standalone Work package.
 *
 * @module work/vitest
 * @file Vitest.config.ts
 */

import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		coverage: {
			enabled: false,
			exclude: ['**/*.test.ts', '**/*.int.test.ts', '**/node_modules/**', '**/coverage/**'],
			include: ['src/**/*.ts'],
			provider: 'v8',
			reporter: ['text-summary', 'json-summary'],
			reportsDirectory: 'coverage',
		},
		environment: 'node',
		exclude: ['**/node_modules/**', '**/.git/**', '**/*.int.test.ts'],
		include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
		testTimeout: 30_000,
	},
})
