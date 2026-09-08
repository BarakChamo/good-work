/**
 * @description Verifies bounded file reads preserve primary failures when handle cleanup also fails.
 *
 * @module work/files
 * @file Files.test.ts
 */

/* oxlint-disable typescript/consistent-type-imports, vitest/prefer-import-in-mock -- Typed Vitest built-in-module interception is required to inject a file-handle cleanup failure. */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readBoundedContainedFile, readBoundedFile, writeUtf8NoFollow } from './files'

const PRIVATE_CANARY = 'PRIVATE_FILE_CANARY_/Users/operator/secret.md'

const fileFailure = vi.hoisted(() => ({ close: false, write: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>()
	return {
		...actual,
		open: async (...arguments_: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...arguments_)
			if (fileFailure.write) {
				vi.spyOn(handle, 'writeFile').mockRejectedValue(new Error(PRIVATE_CANARY))
			}
			if (fileFailure.close) {
				const close = handle.close.bind(handle)
				vi.spyOn(handle, 'close').mockImplementation(async () => {
					await close()
					throw new Error(PRIVATE_CANARY)
				})
			}
			return handle
		},
	}
})

let root: string

beforeEach(async () => {
	fileFailure.close = false
	fileFailure.write = false
	root = await mkdtemp(join(tmpdir(), 'work-contract-files-'))
})

afterEach(async () => {
	fileFailure.close = false
	fileFailure.write = false
	await rm(root, { force: true, recursive: true })
})

describe('bounded file reads', () => {
	it('rejects an intermediate-directory swap after opening a contained reference', async () => {
		expect.hasAssertions()
		const outside = await mkdtemp(join(tmpdir(), 'work-contract-files-outside-'))
		await writeFile(join(outside, 'result.json'), 'outside secret')
		await symlink(outside, join(root, 'evidence'))
		try {
			const result = await readBoundedContainedFile({
				root,
				reference: 'evidence/result.json',
				maxBytes: 1024,
				unsafeCode: 'unsafe_evidence_path',
				unavailableCode: 'evidence_unavailable',
				tooLargeCode: 'evidence_too_large',
				label: 'Evidence file',
				afterOpen: async () => {
					await rm(join(root, 'evidence'))
					await mkdir(join(root, 'evidence'))
					await writeFile(join(root, 'evidence', 'result.json'), 'inside replacement')
				},
			})

			expect(result).toMatchObject({
				ok: false,
				error: { type: 'work_contract_error', code: 'unsafe_evidence_path' },
			})
			expect(JSON.stringify(result)).not.toContain('outside secret')
		} finally {
			await rm(outside, { force: true, recursive: true })
		}
	})

	it('keeps the size violation primary when handle cleanup also fails', async () => {
		expect.hasAssertions()
		const path = join(root, 'oversized.txt')
		await writeFile(path, 'too large')
		fileFailure.close = true

		const result = await readBoundedFile({
			path,
			maxBytes: 1,
			unavailableCode: 'source_read_failed',
			tooLargeCode: 'source_too_large',
			label: 'Work source',
		})

		expect(result).toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'source_too_large' },
		})
		if (result.ok) {
			return
		}
		expect(result.error.details).toContain('File-handle cleanup failed.')
		expect(JSON.stringify(result)).not.toContain(PRIVATE_CANARY)
	})

	it('reports only a stable system category when an input path cannot be opened', async () => {
		expect.hasAssertions()
		const result = await readBoundedFile({
			path: join(root, PRIVATE_CANARY),
			maxBytes: 10,
			unavailableCode: 'source_read_failed',
			tooLargeCode: 'source_too_large',
			label: 'Work source',
		})

		expect(result).toMatchObject({
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'source_read_failed',
				details: ['System error code: ENOENT.'],
			},
		})
		expect(JSON.stringify(result)).not.toContain(PRIVATE_CANARY)
	})

	it('does not expose raw write failures to callers', async () => {
		expect.hasAssertions()
		fileFailure.write = true
		let thrown: unknown
		try {
			await writeUtf8NoFollow({
				path: join(root, 'output.txt'),
				content: 'safe content',
				mode: 'exclusive',
			})
		} catch (error: unknown) {
			thrown = error
		}

		expect(thrown).toBeInstanceOf(Error)
		expect(thrown instanceof Error ? thrown.message : String(thrown)).toBe('File write failed.')
		expect(JSON.stringify(thrown)).not.toContain(PRIVATE_CANARY)
	})

	it('keeps the previous authority file intact when atomic replacement staging fails', async () => {
		expect.hasAssertions()
		const path = join(root, 'authority.txt')
		await writeFile(path, 'previous generation')
		fileFailure.write = true

		await expect(
			writeUtf8NoFollow({ path, content: 'replacement generation', mode: 'replace' }),
		).rejects.toThrow('Atomic file replacement failed.')
		await expect(
			import('node:fs/promises').then(async ({ readFile }) => readFile(path, 'utf8')),
		).resolves.toBe('previous generation')
	})

	it('does not expose a rejected output path through open failures', async () => {
		expect.hasAssertions()
		let thrown: unknown
		try {
			await writeUtf8NoFollow({
				path: join(root, PRIVATE_CANARY, 'output.txt'),
				content: 'safe content',
				mode: 'exclusive',
			})
		} catch (error: unknown) {
			thrown = error
		}

		expect(thrown).toBeInstanceOf(Error)
		expect(thrown instanceof Error ? thrown.message : String(thrown)).toBe(
			'File open failed. System error code: ENOENT.',
		)
		expect(thrown).toMatchObject({ code: 'ENOENT' })
		expect(thrown instanceof Error ? thrown.message : String(thrown)).not.toContain(PRIVATE_CANARY)
	})
})
