/**
 * @description Verifies the cooperative external-state integration mutex.
 *
 * @module work/integration-mutex.test
 * @file Integration-mutex.test.ts
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, test } from 'vitest'

import {
	acquireIntegrationMutex,
	inspectIntegrationMutex,
	recoverIntegrationMutex,
	releaseIntegrationMutex,
} from './integration-mutex'

const roots: string[] = []
afterEach(async () =>
	Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))),
)

test('allows exactly one concurrent local integration owner', async () => {
	expect.hasAssertions()
	const root = await mkdtemp(join(tmpdir(), 'work-integration-mutex-'))
	roots.push(root)
	const results = await Promise.all([
		acquireIntegrationMutex({ root, actor: 'one', session: 'a' }),
		acquireIntegrationMutex({ root, actor: 'two', session: 'b' }),
	])
	expect(results.filter(({ ok }) => ok)).toHaveLength(1)
	expect(results.filter(({ ok }) => !ok)).toHaveLength(1)
	const winner = results.find(({ ok }) => ok)
	await expect(inspectIntegrationMutex(root)).resolves.toMatchObject({
		ok: true,
		value: winner?.ok ? { nonce: winner.value.nonce } : {},
	})
	await expect(acquireIntegrationMutex({ root, actor: 'three' })).resolves.toMatchObject({
		ok: false,
		error: { code: 'integration_locked' },
	})
	await expect(inspectIntegrationMutex(root)).resolves.toMatchObject({
		ok: true,
		value: winner?.ok ? { nonce: winner.value.nonce } : {},
	})
})

test('requires the owner to release and supports explicit recovery', async () => {
	expect.hasAssertions()
	const root = await mkdtemp(join(tmpdir(), 'work-integration-mutex-'))
	roots.push(root)
	const acquired = await acquireIntegrationMutex({ root, actor: 'one' })
	expect(acquired.ok).toBe(true)
	if (!acquired.ok) {
		return
	}
	await expect(
		releaseIntegrationMutex({ root, actor: 'two', nonce: acquired.value.nonce }),
	).resolves.toMatchObject({
		ok: false,
		error: { code: 'integration_lock_release_failed' },
	})
	const recovered = await recoverIntegrationMutex({
		root,
		actor: 'two',
		reason: 'Original worker stopped.',
	})
	expect(recovered.ok).toBe(true)
	if (!recovered.ok) {
		return
	}
	await expect(inspectIntegrationMutex(root)).resolves.toMatchObject({
		ok: true,
		value: {
			actor: 'two',
			recoveryReason: 'Original worker stopped.',
			recoveredFrom: { actor: 'one', nonce: acquired.value.nonce },
		},
	})
	await expect(
		releaseIntegrationMutex({ root, actor: 'one', nonce: acquired.value.nonce }),
	).resolves.toMatchObject({ ok: false, error: { code: 'integration_lock_release_failed' } })
	await expect(inspectIntegrationMutex(root)).resolves.toMatchObject({
		ok: true,
		value: { actor: 'two', nonce: recovered.value.nonce },
	})
	await expect(
		releaseIntegrationMutex({ root, actor: 'two', nonce: recovered.value.nonce }),
	).resolves.toStrictEqual({
		ok: true,
		value: { released: true },
	})
})

test('keeps the canonical mutex occupied while replacing a guarded stale owner', async () => {
	expect.hasAssertions()
	const root = await mkdtemp(join(tmpdir(), 'work-integration-mutex-'))
	roots.push(root)
	const acquired = await acquireIntegrationMutex({ root, actor: 'one' })
	expect(acquired.ok).toBe(true)
	if (!acquired.ok) {
		return
	}
	let announceGuard: (() => void) | undefined
	const guarded = new Promise<void>((resolve) => {
		announceGuard = resolve
	})
	let continueRecovery: (() => void) | undefined
	const continuation = new Promise<void>((resolve) => {
		continueRecovery = resolve
	})
	const recovery = recoverIntegrationMutex({
		root,
		actor: 'two',
		reason: 'Original worker stopped.',
		onGuarded: async () => {
			announceGuard?.()
			await continuation
		},
	})
	await guarded
	await expect(acquireIntegrationMutex({ root, actor: 'three' })).resolves.toMatchObject({
		ok: false,
		error: { code: 'integration_locked' },
	})
	await expect(
		releaseIntegrationMutex({ root, actor: 'one', nonce: acquired.value.nonce }),
	).resolves.toMatchObject({ ok: false })
	continueRecovery?.()
	const recovered = await recovery
	expect(recovered).toMatchObject({ ok: true, value: { actor: 'two' } })
	await expect(inspectIntegrationMutex(root)).resolves.toMatchObject({
		ok: true,
		value: { actor: 'two' },
	})
})

test('fails closed for pre-existing empty and oversized canonical mutex paths', async () => {
	expect.hasAssertions()
	const root = await mkdtemp(join(tmpdir(), 'work-integration-mutex-'))
	roots.push(root)
	const workDirectory = join(root, '.work')
	const lockPath = join(workDirectory, 'integration.lock')
	await mkdir(lockPath, { recursive: true })
	await expect(acquireIntegrationMutex({ root, actor: 'one' })).resolves.toMatchObject({
		ok: false,
		error: { code: 'invalid_integration_lock' },
	})
	await rm(lockPath, { recursive: true })
	await writeFile(lockPath, 'x'.repeat(8 * 1024 + 1))
	await expect(inspectIntegrationMutex(root)).resolves.toMatchObject({
		ok: false,
		error: { code: 'invalid_integration_lock' },
	})
	await expect(
		recoverIntegrationMutex({ root, actor: 'two', reason: 'Manual repair.' }),
	).resolves.toMatchObject({
		ok: false,
		error: { code: 'invalid_integration_lock' },
	})
})
