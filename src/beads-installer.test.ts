/**
 * @description Proves pinned Beads release targeting and checksum-manifest validation.
 *
 * @module work/beads-installer
 * @file Beads-installer.test.ts
 */

import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import {
	installPinnedBeads,
	parseBeadsVersionOutput,
	parseExpectedChecksum,
	resolveReleaseTarget,
} from './beads-installer'
import type { BeadsInstallerRuntime } from './beads-installer'
import { installationFailure } from './beads-installer-errors'

const createRuntime = (overrides: Partial<BeadsInstallerRuntime> = {}): BeadsInstallerRuntime => ({
	architecture: 'arm64',
	changeMode: vi.fn(async () => {}),
	copyFile: vi.fn(async () => {}),
	fetch: vi.fn(async () => new Response(null, { status: 503 })),
	makeTemporaryDirectory: vi.fn(async () => '/os-temp/work-contract-beads-install-fixture'),
	platform: 'darwin',
	readFile: vi.fn(async () => new Uint8Array([1])),
	remove: vi.fn(async () => {}),
	rename: vi.fn(async () => {}),
	resolveLauncherPath: vi.fn(() => '/provider/bin/bd.js'),
	spawn: vi.fn(() => ({ status: 0, stdout: '' })),
	writeFile: vi.fn(async () => {}),
	...overrides,
})

describe('verified Beads installer', () => {
	it('maps supported Node platforms to exact release assets', () => {
		expect.hasAssertions()
		expect(resolveReleaseTarget('darwin', 'arm64')).toStrictEqual({
			archiveName: 'beads_1.2.2_darwin_arm64.tar.gz',
			binaryName: 'bd',
		})
		expect(resolveReleaseTarget('linux', 'x64')).toStrictEqual({
			archiveName: 'beads_1.2.2_linux_amd64.tar.gz',
			binaryName: 'bd',
		})
		expect(resolveReleaseTarget('win32', 'arm64')).toStrictEqual({
			archiveName: 'beads_1.2.2_windows_arm64.zip',
			binaryName: 'bd.exe',
		})
	})

	it('rejects unsupported targets before network or filesystem effects', () => {
		expect.hasAssertions()
		expect(() => resolveReleaseTarget('freebsd', 'x64')).toThrow('Unsupported Beads platform')
		expect(() => resolveReleaseTarget('linux', 'riscv64')).toThrow('Unsupported Beads architecture')
	})

	it('selects one exact SHA-256 entry and rejects malformed or duplicate manifests', () => {
		expect.hasAssertions()
		const archive = 'beads_1.2.2_linux_amd64.tar.gz'
		const checksum = 'a'.repeat(64)
		expect(parseExpectedChecksum(`${checksum}  ${archive}\n`, archive)).toBe(checksum)
		expect(() => parseExpectedChecksum(`not-a-sha  ${archive}\n`, archive)).toThrow('missing')
		expect(() =>
			parseExpectedChecksum(`${checksum}  ${archive}\n${'b'.repeat(64)} *${archive}\n`, archive),
		).toThrow('duplicate')
		expect(() => parseExpectedChecksum(`${checksum}  another.tar.gz\n`, archive)).toThrow('missing')
	})

	it('validates the semantic version while allowing official build provenance', () => {
		expect.hasAssertions()
		expect(parseBeadsVersionOutput('bd version 1.2.2 (6c124203e: dev@6c124203e771)')).toBe('1.2.2')
		expect(() => parseBeadsVersionOutput('bd version 1.2.1')).toThrow('Expected bd version 1.2.2')
	})

	it('bounds a streamed download without using an unbounded array buffer', async () => {
		expect.hasAssertions()
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(1024 * 1024))
				controller.enqueue(new Uint8Array(1024 * 1024 + 1))
				controller.close()
			},
		})
		const fetchMock = vi
			.fn<BeadsInstallerRuntime['fetch']>()
			.mockResolvedValue(new Response(body, { status: 200 }))
		const runtime = createRuntime({ fetch: fetchMock })

		await expect(installPinnedBeads(runtime)).resolves.toMatchObject({
			ok: false,
			error: {
				code: 'provider_failed',
				details: ['stage=checksum_download', expect.stringContaining('recovery=')],
			},
		})
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('classifies operating-system temp cleanup failures at the installer boundary', async () => {
		expect.hasAssertions()
		const runtime = createRuntime({
			remove: async (path: string) => {
				if (path.includes('work-contract-beads-install-')) {
					throw new Error('simulated cleanup failure')
				}
			},
		})

		await expect(installPinnedBeads(runtime)).resolves.toMatchObject({
			ok: false,
			error: {
				details: [
					'stage=checksum_download',
					'cleanupResidue=operating_system_temp_directory',
					expect.stringContaining('work-contract-beads-install-*'),
				],
			},
		})
	})

	it('classifies provider-binary cleanup failures at the installer boundary', async () => {
		expect.hasAssertions()
		const archiveBytes = new TextEncoder().encode('fixture-archive')
		const archiveName = 'beads_1.2.2_windows_arm64.zip'
		const checksum = createHash('sha256').update(archiveBytes).digest('hex')
		const fetchRelease = vi
			.fn<BeadsInstallerRuntime['fetch']>()
			.mockResolvedValueOnce(new Response(`${checksum}  ${archiveName}\n`, { status: 200 }))
			.mockResolvedValueOnce(new Response(archiveBytes, { status: 200 }))
		const spawn = vi
			.fn<BeadsInstallerRuntime['spawn']>()
			.mockReturnValueOnce({ status: 0, stdout: '' })
			.mockReturnValueOnce({ status: 0, stdout: 'bd version 1.2.2 (fixture)' })
		const runtime = createRuntime({
			fetch: fetchRelease,
			platform: 'win32',
			spawn,
			remove: async (path: string) => {
				if (path.startsWith('/provider/bin/bd.exe.tmp-')) {
					throw new Error('simulated cleanup failure')
				}
			},
		})

		await expect(installPinnedBeads(runtime)).resolves.toMatchObject({
			ok: false,
			error: {
				details: [
					'stage=cleanup',
					'cleanupResidue=provider_binary_directory',
					expect.stringContaining('bd.exe.tmp-*'),
				],
			},
		})
	})

	it('keeps a verified installation successful when only OS temp cleanup is blocked', async () => {
		expect.hasAssertions()
		const archiveBytes = new TextEncoder().encode('fixture-archive')
		const archiveName = 'beads_1.2.2_windows_arm64.zip'
		const checksum = createHash('sha256').update(archiveBytes).digest('hex')
		const runtime = createRuntime({
			fetch: vi
				.fn<BeadsInstallerRuntime['fetch']>()
				.mockResolvedValueOnce(new Response(`${checksum}  ${archiveName}\n`, { status: 200 }))
				.mockResolvedValueOnce(new Response(archiveBytes, { status: 200 })),
			platform: 'win32',
			spawn: vi
				.fn<BeadsInstallerRuntime['spawn']>()
				.mockReturnValueOnce({ status: 0, stdout: '' })
				.mockReturnValueOnce({ status: 0, stdout: 'bd version 1.2.2 (fixture)' }),
			remove: async (path: string) => {
				if (path.includes('work-contract-beads-install-')) {
					throw new Error('simulated Windows scanner lock')
				}
			},
		})

		await expect(installPinnedBeads(runtime)).resolves.toEqual({
			ok: true,
			value: 'bd version 1.2.2 (fixture)',
		})
	})

	it('keeps cleanup diagnostics free of concrete paths', () => {
		expect.hasAssertions()
		expect(installationFailure('cleanup', ['provider_binary_directory'])).toMatchObject({
			ok: false,
			error: {
				code: 'provider_failed',
				details: [
					'stage=cleanup',
					'cleanupResidue=provider_binary_directory',
					expect.not.stringContaining(process.cwd()),
				],
			},
		})
	})
})
