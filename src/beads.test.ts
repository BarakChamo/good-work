/**
 * @description Verifies fail-closed Beads adapter behavior against malformed and ambiguous CLI output.
 *
 * @module work/beads
 * @file Beads.test.ts
 */

/* oxlint-disable eslint/max-statements, vitest/prefer-expect-assertions, typescript/no-unsafe-type-assertion, typescript/no-unsafe-return, typescript/promise-function-async -- Adapter assertions follow Result narrowing; the fixture proxy supplies a shared exact-definition expectation while preserving the production API surface. */

import { createHash } from 'node:crypto'
import { access, chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env as processEnvironment } from 'node:process'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	BEADS_PROVIDER_LIMITS,
	createBeadsProvider as createRealBeadsProvider,
	InvalidBeadsProviderInputError,
} from './beads'
import type {
	LedgerActivityInput,
	LedgerClaimInput,
	LedgerDependencyExpectation,
	LedgerDefinitionExpectation,
	LedgerDefinitionInput,
	LedgerHandoffInput,
	LedgerTransitionInput,
} from './provider'

let root: string

const definition: LedgerDefinitionInput = {
	projectId: 'example',
	graphFingerprint: 'c'.repeat(64),
	artifact: {
		id: 'ISSUE-1',
		kind: 'issue',
		execution: 'task',
		title: 'Issue',
		source: { path: 'docs/ISSUE-1.md', hash: 'd'.repeat(64) },
		dependencies: [],
		acceptance: [],
		owners: [],
		roles: ['implementer', 'reviewer'],
		evidenceRequirements: [],
		body: 'Issue body.',
	},
}

const expectedDefinition = {
	schemaVersion: 2 as const,
	graphFingerprint: 'b'.repeat(64),
	title: 'Issue',
	kind: 'issue' as const,
	execution: 'task' as const,
	source: { path: 'docs/ISSUE-1.md', hash: 'a'.repeat(64) },
	parentId: undefined,
	dependencies: [],
	roles: ['implementer', 'reviewer'],
	evidenceRequirements: [],
}

const providerIdFor = (projectId: string, workId: string): string =>
	`sw-${createHash('sha256').update(`${projectId}\0${workId}`).digest('hex').slice(0, 20)}`
const exampleProviderId = (workId: string): string => providerIdFor('example', workId)

type WithDefaultDefinition<T extends { readonly expectedDefinition: LedgerDefinitionExpectation }> =
	T extends { readonly expectedDefinition: LedgerDefinitionExpectation }
		? Omit<T, 'expectedDefinition'> & {
				readonly expectedDefinition?: LedgerDefinitionExpectation
			}
		: never

type WithDefaultDependencies<T> = T extends {
	readonly expectedDependencies: readonly LedgerDependencyExpectation[]
}
	? Omit<T, 'expectedDependencies'> & {
			readonly expectedDependencies?: readonly LedgerDependencyExpectation[]
		}
	: T

type WithDefaultDefinitionClosure<T> = T extends {
	readonly expectedDefinitionClosure: readonly unknown[]
}
	? Omit<T, 'expectedDefinitionClosure'> & {
			readonly expectedDefinitionClosure?: readonly LedgerDependencyExpectation[]
		}
	: T

type WithDefaultActivityMode<T extends LedgerActivityInput> = Omit<T, 'replaceSession'> & {
	readonly replaceSession?: boolean
}

type AdapterTestInput<T extends { readonly expectedDefinition: LedgerDefinitionExpectation }> =
	WithDefaultDependencies<WithDefaultDefinitionClosure<WithDefaultDefinition<T>>> & {
		readonly dependencyRequirements?: readonly unknown[]
	}

type RealProvider = ReturnType<typeof createRealBeadsProvider>
type TestProvider = Omit<
	RealProvider,
	'claim' | 'recordActivity' | 'recordHandoff' | 'transition'
> & {
	readonly claim: (input: AdapterTestInput<LedgerClaimInput>) => ReturnType<RealProvider['claim']>
	readonly recordActivity: (
		input: WithDefaultDefinitionClosure<
			WithDefaultDefinition<WithDefaultActivityMode<LedgerActivityInput>>
		>,
	) => ReturnType<RealProvider['recordActivity']>
	readonly recordHandoff: (
		input: AdapterTestInput<LedgerHandoffInput>,
	) => ReturnType<RealProvider['recordHandoff']>
	readonly transition: (
		input: AdapterTestInput<LedgerTransitionInput>,
	) => ReturnType<RealProvider['transition']>
}

const createBeadsProvider = (
	input: Parameters<typeof createRealBeadsProvider>[0],
): TestProvider => {
	const provider = createRealBeadsProvider(input)
	const definitionFor = (value: {
		readonly workId: string
		readonly expectedDefinition?: LedgerDefinitionExpectation
		readonly expectedDependencies?: readonly LedgerDependencyExpectation[]
		readonly dependencyRequirements?: readonly unknown[]
	}): LedgerDefinitionExpectation => {
		if (value.expectedDefinition !== undefined) {
			return value.expectedDefinition
		}
		const dependencies =
			value.expectedDependencies?.map(({ workId }) => workId) ??
			(value.dependencyRequirements ?? []).flatMap((requirement) =>
				typeof requirement === 'object' &&
				requirement !== null &&
				'workId' in requirement &&
				typeof requirement.workId === 'string'
					? [requirement.workId]
					: [],
			)
		return {
			...expectedDefinition,
			source: { ...expectedDefinition.source, path: `docs/${value.workId}.md` },
			dependencies,
		}
	}
	const dependenciesFor = (value: {
		readonly expectedDependencies?: readonly LedgerDependencyExpectation[]
		readonly dependencyRequirements?: readonly unknown[]
	}): readonly LedgerDependencyExpectation[] =>
		value.expectedDependencies ??
		(value.dependencyRequirements ?? []).flatMap((requirement) => {
			if (
				typeof requirement !== 'object' ||
				requirement === null ||
				!('workId' in requirement) ||
				typeof requirement.workId !== 'string'
			) {
				return []
			}
			const evidenceRequirements =
				'evidenceRequirements' in requirement && Array.isArray(requirement.evidenceRequirements)
					? requirement.evidenceRequirements
					: []
			return [
				{
					...expectedDefinition,
					workId: requirement.workId,
					source: {
						...expectedDefinition.source,
						path: `docs/${requirement.workId}.md`,
					},
					evidenceRequirements,
				},
			]
		})
	const definitionClosureFor = (value: {
		readonly workId: string
		readonly expectedDefinition?: LedgerDefinitionExpectation
		readonly expectedDefinitionClosure?: readonly LedgerDependencyExpectation[]
		readonly expectedDependencies?: readonly LedgerDependencyExpectation[]
		readonly dependencyRequirements?: readonly unknown[]
	}): readonly LedgerDependencyExpectation[] =>
		value.expectedDefinitionClosure ?? [
			{ workId: value.workId, ...definitionFor(value) },
			...dependenciesFor(value),
		]
	return new Proxy(provider, {
		get(target, property) {
			if (property === 'claim') {
				return (value: AdapterTestInput<LedgerClaimInput>) => {
					const { dependencyRequirements: _, ...request } = value
					return target.claim({
						...request,
						expectedDefinition: definitionFor(value),
						expectedDefinitionClosure: definitionClosureFor(value),
						expectedDependencies: dependenciesFor(value),
					})
				}
			}
			if (property === 'recordActivity') {
				return (
					value: WithDefaultDefinitionClosure<
						WithDefaultDefinition<WithDefaultActivityMode<LedgerActivityInput>>
					>,
				) =>
					target.recordActivity({
						...value,
						replaceSession: value.replaceSession ?? false,
						expectedDefinition: definitionFor(value),
						expectedDefinitionClosure: definitionClosureFor(value),
					})
			}
			if (property === 'recordHandoff') {
				return (value: WithDefaultDefinitionClosure<WithDefaultDefinition<LedgerHandoffInput>>) =>
					target.recordHandoff({
						...value,
						expectedDefinition: definitionFor(value),
						expectedDefinitionClosure: definitionClosureFor(value),
					})
			}
			if (property === 'transition') {
				return (value: AdapterTestInput<LedgerTransitionInput>) => {
					const { dependencyRequirements: _, ...request } = value
					return target.transition({
						...request,
						expectedDefinition: definitionFor(value),
						expectedDefinitionClosure: definitionClosureFor(value),
						...(value.type === 'complete' ? { expectedDependencies: dependenciesFor(value) } : {}),
					} as LedgerTransitionInput)
				}
			}
			const value: unknown = Reflect.get(target, property, target)
			return typeof value === 'function' ? value.bind(target) : value
		},
	}) as TestProvider
}

const record = (
	providerId: string,
	input: {
		readonly archived?: boolean
		readonly kind?: 'eval' | 'issue' | 'prd' | 'task'
		readonly status?: 'open' | 'closed'
	} = {},
) => ({
	id: providerId,
	title: 'Issue',
	status: input.status ?? 'open',
	priority: 2,
	issue_type: input.kind ?? 'issue',
	created_at: '2026-09-01T00:00:00.000Z',
	updated_at: '2026-09-01T00:00:00.000Z',
	metadata: {
		work_contract_project_key: createHash('sha256').update('example').digest('hex'),
		work_contract: {
			schema_version: 2,
			project_id: 'example',
			work_id: 'ISSUE-1',
			kind: input.kind ?? 'issue',
			source_path: 'docs/ISSUE-1.md',
			source_hash: 'a'.repeat(64),
			graph_fingerprint: 'b'.repeat(64),
			roles: ['implementer', 'reviewer'],
			evidence_requirements: [],
			...(input.archived === undefined ? {} : { archived: input.archived }),
		},
	},
})

const writeFakeBinary = async (body: string): Promise<string> => {
	const binary = join(root, 'fake-bd.mjs')
	await writeFile(binary, `#!/usr/bin/env node\n${body}\n`)
	await chmod(binary, 0o755)
	return binary
}

const providerLockPath = (projectId: string, workId: string): string =>
	join(
		root,
		'.work',
		`beads-${createHash('sha256').update(projectId).digest('hex').slice(0, 12)}-${createHash('sha256').update(workId).digest('hex').slice(0, 12)}.lock`,
	)

const legacyProviderLockPath = (projectId: string): string =>
	join(
		root,
		'.work',
		`beads-${createHash('sha256').update(projectId).digest('hex').slice(0, 16)}.lock`,
	)

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'work-contract-beads-unit-'))
	await mkdir(join(root, '.work'), { recursive: true })
})

afterEach(async () => {
	await rm(root, { force: true, recursive: true })
})

describe('beads adapter boundary', () => {
	it('keeps the maximum admitted raw project below the child-output ceiling', () => {
		expect(
			BEADS_PROVIDER_LIMITS.items * (BEADS_PROVIDER_LIMITS.rawRecordReserveBytes + 1) + 2,
		).toBeLessThanOrEqual(BEADS_PROVIDER_LIMITS.listOutputBytes)
	})

	it('returns beads_unavailable when the configured executable does not exist', async () => {
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary: join(root, 'missing-bd'),
		})

		await expect(provider.initialize()).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'beads_unavailable' },
		})
	})

	it('does not forward unrelated parent credentials to the provider subprocess', async () => {
		const environmentKey = 'WORK_CONTRACT_PRIVATE_PROVIDER_CANARY'
		processEnvironment[environmentKey] = 'secret-value'
		const binary = await writeFakeBinary(`
if (process.env[${JSON.stringify(environmentKey)}] !== undefined) process.exit(9)
if (process.argv[2] === 'version') console.log('bd version 1.2.2')
else process.exit(9)
`)
		try {
			await expect(
				createBeadsProvider({ root, projectId: 'example', binary }).doctor(),
			).resolves.toMatchObject({ ok: true, value: { version: '1.2.2' } })
		} finally {
			Reflect.deleteProperty(processEnvironment, environmentKey)
		}
	})

	it('binds every provider subprocess to the explicit shared state directory', async () => {
		const stateDirectory = join(root, 'shared-state')
		await mkdir(stateDirectory)
		const binary = await writeFakeBinary(`
if (process.env.BEADS_DIR !== ${JSON.stringify(stateDirectory)}) process.exit(9)
if (process.argv[2] === 'version') console.log('bd version 1.2.2')
else process.exit(9)
`)

		await expect(
			createBeadsProvider({ root, projectId: 'example', binary, stateDirectory }).doctor(),
		).resolves.toMatchObject({ ok: true, value: { version: '1.2.2' } })
	})

	it('disables the Beads daemon for every provider subprocess', async () => {
		const binary = await writeFakeBinary(`
if (process.env.BEADS_NO_DAEMON !== '1') process.exit(9)
if (process.argv[2] === 'version') console.log('bd version 1.2.2')
else process.exit(9)
`)

		await expect(
			createBeadsProvider({ root, projectId: 'example', binary }).doctor(),
		).resolves.toMatchObject({ ok: true, value: { version: '1.2.2' } })
	})

	it('runs decorated provider reads in Beads read-only mode', async () => {
		const argsLog = join(root, 'args.log')
		const binary = await writeFakeBinary(`
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(argsLog)}, process.argv.slice(2).join('\t'))
if (process.argv[2] === 'list') console.log('[]')
else process.exit(9)
`)

		await expect(
			createBeadsProvider({ root, projectId: 'example', binary }).list(),
		).resolves.toMatchObject({ ok: true, value: [] })
		await expect(readFile(argsLog, 'utf8')).resolves.toContain('list\t--all\t--metadata-field')
		await expect(readFile(argsLog, 'utf8')).resolves.toContain(
			'\t--readonly\t--json\t--directory\t',
		)
	})

	it('preserves the shared recovery projection when provider export is malformed', async () => {
		await mkdir(join(root, '.beads'), { recursive: true })
		const projection = join(root, '.beads/export-state/issues.jsonl')
		await mkdir(join(root, '.beads/export-state'), { recursive: true })
		await writeFile(projection, '{"id":"preserved"}\n')
		const binary = await writeFakeBinary(`
import { writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const output = args[args.indexOf('--output') + 1]
if (args[0] !== 'export' || output === undefined) process.exit(9)
writeFileSync(output, 'malformed projection\\n')
console.log('{}')
`)
		const provider = createBeadsProvider({ root, projectId: 'example', binary })

		await expect(provider.publishRecoveryProjection()).resolves.toMatchObject({
			ok: false,
			error: { code: 'projection_write_failed' },
		})
		await expect(readFile(projection, 'utf8')).resolves.toBe('{"id":"preserved"}\n')
	})

	it.each([
		['empty', ''],
		['partial', `${JSON.stringify(record('wc-other'))}\n`],
	] as const)(
		'preserves the shared recovery projection when provider export is %s',
		async (_, output) => {
			await mkdir(join(root, '.beads/export-state'), { recursive: true })
			const projection = join(root, '.beads/export-state/issues.jsonl')
			const preserved = `${JSON.stringify(record('wc-preserved'))}\n`
			await writeFile(projection, preserved)
			const binary = await writeFakeBinary(`
import { writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const target = args[args.indexOf('--output') + 1]
if (args[0] !== 'export' || target === undefined) process.exit(9)
writeFileSync(target, ${JSON.stringify(output)})
console.log('{}')
`)
			const provider = createBeadsProvider({ root, projectId: 'example', binary })

			await expect(provider.publishRecoveryProjection()).resolves.toMatchObject({
				ok: false,
				error: { code: 'projection_write_failed' },
			})
			await expect(readFile(projection, 'utf8')).resolves.toBe(preserved)
		},
	)

	it.each(['missing', 'empty'] as const)(
		'reconstructs authoritative recovery completeness when the prior projection is %s',
		async (priorState) => {
			const projection = join(root, '.beads/export-state/issues.jsonl')
			await mkdir(join(root, '.beads'), { recursive: true })
			if (priorState === 'empty') {
				await mkdir(join(root, '.beads/export-state'), { recursive: true })
				await writeFile(projection, '')
			}
			const current = record('wc-current')
			const historical = record('wc-historical')
			const binary = await writeFakeBinary(`
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
const args = process.argv.slice(2)
if (args[0] === 'list') {
  console.log(JSON.stringify([${JSON.stringify(current)}, ${JSON.stringify(historical)}]))
} else if (args[0] === 'export') {
  const target = args[args.indexOf('--output') + 1]
  if (target === undefined) process.exit(9)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, ${JSON.stringify(`${JSON.stringify(current)}\n`)})
  console.log('{}')
} else process.exit(9)
`)
			const provider = createBeadsProvider({ root, projectId: 'example', binary })

			await expect(
				provider.publishRecoveryProjection({ expected: [{ workId: 'ISSUE-1' }] }),
			).resolves.toMatchObject({
				ok: false,
				error: { code: 'projection_write_failed' },
			})
			if (priorState === 'empty') {
				await expect(readFile(projection, 'utf8')).resolves.toBe('')
			} else {
				await expect(access(projection)).rejects.toThrow('ENOENT')
			}
		},
	)

	it('requires an expected mutation state before publishing recovery data', async () => {
		await mkdir(join(root, '.beads/export-state'), { recursive: true })
		const projection = join(root, '.beads/export-state/issues.jsonl')
		const preserved = `${JSON.stringify(record('wc-preserved'))}\n`
		await writeFile(projection, preserved)
		const binary = await writeFakeBinary(`
import { writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const target = args[args.indexOf('--output') + 1]
if (args[0] !== 'export' || target === undefined) process.exit(9)
writeFileSync(target, ${JSON.stringify(preserved)})
console.log('{}')
`)
		const provider = createBeadsProvider({ root, projectId: 'example', binary })

		await expect(
			provider.publishRecoveryProjection({
				expected: [{ workId: 'ISSUE-1', status: 'closed' }],
			}),
		).resolves.toMatchObject({
			ok: false,
			error: { code: 'projection_write_failed' },
		})
		await expect(readFile(projection, 'utf8')).resolves.toBe(preserved)
	})

	it.each(['task', 'eval'] as const)(
		'accepts documented %s kind in owned metadata',
		async (kind) => {
			const item = JSON.stringify(record(`wc-${kind}`, { kind }))
			const binary = await writeFakeBinary(`
if (process.argv[2] === 'list') console.log(JSON.stringify([${item}]))
else if (process.argv[2] === 'show') console.log(${JSON.stringify(item)})
else process.exit(9)
`)
			const provider = createBeadsProvider({
				root,
				projectId: 'example',
				binary,
			})

			await expect(provider.list()).resolves.toMatchObject({
				ok: true,
				value: [{ kind }],
			})
		},
	)

	it('parses public adapter construction input', () => {
		expect(() => createBeadsProvider({ root: '', projectId: 'example' })).toThrow(
			InvalidBeadsProviderInputError,
		)
		const privateCanary = 'PRIVATE_EXECUTABLE_/Users/operator/secret'
		let thrown: unknown
		try {
			createBeadsProvider({
				root,
				projectId: 'example',
				binary: `${privateCanary}\0bd`,
			})
		} catch (error: unknown) {
			thrown = error
		}
		expect(thrown).toBeInstanceOf(InvalidBeadsProviderInputError)
		expect(JSON.stringify(thrown)).not.toContain(privateCanary)
	})

	it('bounds and redacts unsupported provider version output', async () => {
		const canary = '9'.repeat(1_000_000)
		const binary = await writeFakeBinary(
			`if (process.argv[2] === 'version') console.log('bd version ${canary}')\nelse process.exit(9)`,
		)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.doctor()

		expect(result).toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'unsupported_beads' },
		})
		expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(512)
		expect(JSON.stringify(result)).not.toContain(canary.slice(0, 1000))
	})

	it('parses public mutation input before invoking Beads', async () => {
		const log = join(root, 'commands.log')
		const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(log)}, 'invoked\\n')
process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		await expect(
			provider.claim({
				workId: 'ISSUE-1',
				actor: '',
				timestamp: 'not-a-timestamp',
				dependencyRequirements: [],
			}),
		).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_operation_input' },
		})
		await expect(readFile(log, 'utf8')).rejects.toThrow('ENOENT')
	})

	it('rejects malformed fields in the owned metadata namespace', async () => {
		const malformed = JSON.stringify({
			...record('wc-1'),
			metadata: {
				work_contract_project_key: createHash('sha256').update('example').digest('hex'),
				work_contract: {
					...record('wc-1').metadata.work_contract,
					activty: { actor: 'typo-bypass' },
				},
			},
		})
		const binary = await writeFakeBinary(`console.log(JSON.stringify([${malformed}]))`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		await expect(provider.list()).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_beads_record' },
		})
	})

	it('rejects activity whose actor conflicts with the provider assignee', async () => {
		const inconsistent = JSON.stringify({
			...record('wc-1'),
			status: 'in_progress',
			assignee: 'agent-a',
			metadata: {
				...record('wc-1').metadata,
				work_contract: {
					...record('wc-1').metadata.work_contract,
					activity: {
						actor: 'agent-b',
						started_at: '2026-09-01T00:00:00.000Z',
						touched_at: '2026-09-01T00:00:00.000Z',
					},
				},
			},
		})
		const binary = await writeFakeBinary(
			`if (process.argv[2] === 'list') console.log(JSON.stringify([${inconsistent}]))\nelse process.exit(9)`,
		)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		await expect(provider.list()).resolves.toMatchObject({
			ok: false,
			error: { code: 'invalid_ledger_projection' },
		})
	})

	it('rejects cross-project embedded relation metadata', async () => {
		const source = record('wc-1')
		const inconsistent = JSON.stringify({
			...source,
			dependencies: [
				{
					issue_id: 'wc-1',
					depends_on_id: 'wc-other',
					dependency_type: 'blocks',
					metadata: {
						work_contract_project_key: createHash('sha256').update('other').digest('hex'),
						work_contract: {
							...source.metadata.work_contract,
							project_id: 'other',
							work_id: 'ISSUE-9',
						},
					},
				},
			],
		})
		const binary = await writeFakeBinary(
			`if (process.argv[2] === 'list') console.log(JSON.stringify([${inconsistent}]))\nelse process.exit(9)`,
		)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		await expect(provider.list()).resolves.toMatchObject({
			ok: false,
			error: { code: 'invalid_ledger_projection' },
		})
	})

	it('rejects provider record floods before schema traversal', async () => {
		const tiny = {
			id: 'x',
			title: 'x',
			status: 'open',
			priority: 2,
			issue_type: 'task',
			created_at: '2026-09-01T00:00:00.000Z',
			updated_at: '2026-09-01T00:00:00.000Z',
		}
		const binary = await writeFakeBinary(
			`if (process.argv[2] === 'list') console.log(JSON.stringify(Array.from({ length: 10002 }, () => (${JSON.stringify(tiny)}))))\nelse process.exit(9)`,
		)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		await expect(provider.list()).resolves.toMatchObject({
			ok: false,
			error: { code: 'beads_item_limit_exceeded' },
		})
	})

	it('rejects control-bearing provider identifiers without exposing them as ledger items', async () => {
		const privateCanary = '\0PRIVATE_PROVIDER_ID_/Users/operator/secret'
		const malformed = JSON.stringify({ ...record('wc-1'), id: privateCanary })
		const binary = await writeFakeBinary(
			`if (process.argv[2] === 'list') console.log(${JSON.stringify(malformed)})\nelse process.exit(9)`,
		)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.list()

		expect(result).toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_beads_record' },
		})
		expect(JSON.stringify(result)).not.toContain('PRIVATE_PROVIDER_ID')
	})

	it('discovers markerless schema-v1 definitions only through the bounded migration path', async () => {
		const log = join(root, 'commands.log')
		await mkdir(join(root, '.beads'))
		const legacy = {
			...record('wc-1'),
			metadata: {
				work_contract: {
					...record('wc-1').metadata.work_contract,
					schema_version: 1,
					roles: undefined,
					evidence_requirements: undefined,
				},
			},
		}
		const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(log)}, args.join('\\t') + '\\n')
if (args[0] === 'list' && args.includes('--metadata-field')) console.log('[]')
else if (args[0] === 'list' && args.includes('--label')) console.log(${JSON.stringify(JSON.stringify([legacy]))})
else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		await expect(provider.list()).resolves.toMatchObject({ ok: true, value: [] })
		const listed = await provider.discoverLegacyDefinitions?.()
		expect(listed).toMatchObject({
			ok: true,
			value: [{ definitionSchemaVersion: 1, roles: [], evidenceRequirements: [] }],
		})
		await expect(readFile(log, 'utf8')).resolves.toContain('--metadata-field')
		await expect(readFile(log, 'utf8')).resolves.toContain('--label\twork-contract')
		await expect(provider.finalizeLegacyMigration?.()).resolves.toMatchObject({ ok: true })
		const markerPath = join(
			root,
			'.beads/export-state/work-contract',
			`beads-${createHash('sha256').update('example').digest('hex').slice(0, 16)}.migration-v2.json`,
		)
		const marker: unknown = JSON.parse(await readFile(markerPath, 'utf8'))
		await writeFile(markerPath, `${JSON.stringify(marker, undefined, 2)}\n`)
		await writeFile(log, '')
		await expect(provider.discoverLegacyDefinitions?.()).resolves.toMatchObject({
			ok: true,
			value: [],
		})
		await expect(readFile(log, 'utf8')).resolves.toBe('')
	})

	it('upgrades a legacy schema-v1 definition to schema v2 with file-owned policy', async () => {
		const log = join(root, 'commands.log')
		const legacy = {
			...record('wc-1'),
			metadata: {
				work_contract_project_key: createHash('sha256').update('example').digest('hex'),
				work_contract: {
					...record('wc-1').metadata.work_contract,
					schema_version: 1,
					roles: undefined,
					evidence_requirements: undefined,
				},
			},
		}
		const upgraded = {
			...record('wc-1'),
			metadata: {
				work_contract_project_key: createHash('sha256').update('example').digest('hex'),
				work_contract: {
					...record('wc-1').metadata.work_contract,
					schema_version: 2,
					source_hash: definition.artifact.source.hash,
					graph_fingerprint: definition.graphFingerprint,
					roles: definition.artifact.roles,
					evidence_requirements: ['test'],
				},
			},
		}
		const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join('\t') + '\\n')
if (process.argv[2] === 'list') console.log(${JSON.stringify(JSON.stringify([legacy]))})
else if (process.argv[2] === 'update') console.log(${JSON.stringify(JSON.stringify(upgraded))})
else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.updateDefinition({
			...definition,
			artifact: { ...definition.artifact, evidenceRequirements: ['test'] },
		})

		expect(result).toMatchObject({
			ok: true,
			value: {
				definitionSchemaVersion: 2,
				roles: ['implementer', 'reviewer'],
				evidenceRequirements: ['test'],
			},
		})
		const commands = await readFile(log, 'utf8')
		expect(commands).toContain('"schema_version":2')
		expect(commands).toContain('"roles":["implementer","reviewer"]')
		expect(commands).toContain('"evidence_requirements":["test"]')
	})

	it('migrates schema-v2 metadata to canonical schema v3 without losing active state', async () => {
		const log = join(root, 'commands.log')
		const activity = {
			actor: 'agent-a',
			role: 'implementer',
			session: 'codex:claim-session',
			started_at: '2026-09-01T00:00:00.000Z',
			touched_at: '2026-09-01T00:01:00.000Z',
		}
		const evidence = {
			kind: 'test',
			reference: 'evidence/test.json',
			digest: '2'.repeat(64),
			recorded_at: '2026-09-01T00:02:00.000Z',
			actor: 'agent-a',
		}
		const candidate = {
			schema_version: 1,
			generation: 1,
			project_id: 'example',
			work_id: 'ISSUE-1',
			graph_fingerprint: definition.graphFingerprint,
			repository_id: '3'.repeat(64),
			head_sha: '4'.repeat(40),
			tree_sha: '5'.repeat(40),
			ref: 'refs/heads/feature',
			isolation: 'worktree',
			submitted_at: '2026-09-01T00:03:00.000Z',
			actor: 'agent-a',
			evidence: [evidence],
		}
		const gate = {
			schema_version: 1,
			gate: 'validation',
			result: 'passed',
			candidate_generation: 1,
			project_id: 'example',
			work_id: 'ISSUE-1',
			graph_fingerprint: definition.graphFingerprint,
			repository_id: candidate.repository_id,
			head_sha: candidate.head_sha,
			tree_sha: candidate.tree_sha,
			issuer: { kind: 'self', id: 'agent-a' },
			reference: 'validation:agent-a',
			digest: '6'.repeat(64),
			observed_at: '2026-09-01T00:04:00.000Z',
		}
		const current = {
			...record('wc-1'),
			status: 'in_progress',
			assignee: 'agent-a',
			metadata: {
				...record('wc-1').metadata,
				work_contract: {
					...record('wc-1').metadata.work_contract,
					source_hash: definition.artifact.source.hash,
					graph_fingerprint: definition.graphFingerprint,
					activity,
					handoff: {
						actor: 'agent-a',
						summary: 'Ready for integration.',
						remaining: ['Integrate candidate.'],
						references: ['evidence/test.json'],
						created_at: '2026-09-01T00:05:00.000Z',
						from_session: activity.session,
						to_actor: 'integrator-a',
					},
					evidence: [evidence],
					candidate,
					gates: [gate],
				},
			},
		}
		const definitionRevision = {
			targetRef: 'refs/heads/main',
			targetSha: '1'.repeat(40),
			graphFingerprint: definition.graphFingerprint,
		}
		const migrated = {
			...current,
			metadata: {
				...current.metadata,
				work_contract: {
					...current.metadata.work_contract,
					schema_version: 3,
					definition_revision: {
						target_ref: definitionRevision.targetRef,
						target_sha: definitionRevision.targetSha,
						graph_fingerprint: definitionRevision.graphFingerprint,
					},
				},
			},
		}
		const binary = await writeFakeBinary(`
import { appendFileSync, readFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join('\\t') + '\\n')
if (process.argv[2] === 'list') console.log(${JSON.stringify(JSON.stringify([current]))})
else if (process.argv[2] === 'update') {
  const value = process.argv[process.argv.indexOf('--metadata') + 1]
  appendFileSync(${JSON.stringify(log)}, value.startsWith('@') ? readFileSync(value.slice(1), 'utf8') : value)
  console.log(${JSON.stringify(JSON.stringify(migrated))})
}
else process.exit(9)
`)
		const provider = createBeadsProvider({ root, projectId: 'example', binary })

		const result = await provider.updateDefinition({ ...definition, definitionRevision })

		expect(result).toMatchObject({
			ok: true,
			value: {
				execution: 'task',
				definitionSchemaVersion: 3,
				status: 'in_progress',
				assignee: 'agent-a',
				activity: {
					actor: 'agent-a',
					role: 'implementer',
					session: 'codex:claim-session',
				},
				handoff: {
					actor: 'agent-a',
					fromSession: 'codex:claim-session',
					toActor: 'integrator-a',
				},
				evidence: [{ actor: 'agent-a', reference: 'evidence/test.json' }],
				candidate: {
					actor: 'agent-a',
					headSha: candidate.head_sha,
					evidence: [{ actor: 'agent-a' }],
				},
				gates: [{ issuer: { kind: 'self', id: 'agent-a' }, result: 'passed' }],
				definitionRevision: {
					targetRef: definitionRevision.targetRef,
					graphFingerprint: definitionRevision.graphFingerprint,
				},
			},
		})
		const commands = await readFile(log, 'utf8')
		expect(commands).toContain('"schema_version":3')
		expect(commands).toContain('"actor":"agent-a"')
	})

	it('rejects semantic definition changes while work is active', async () => {
		const current = {
			...record('wc-1'),
			status: 'in_progress',
			assignee: 'agent-a',
		}
		const binary = await writeFakeBinary(`
if (process.argv[2] === 'list') console.log(${JSON.stringify(JSON.stringify([current]))})
else process.exit(9)
`)
		const provider = createBeadsProvider({ root, projectId: 'example', binary })

		const result = await provider.updateDefinition({
			...definition,
			definitionRevision: {
				targetRef: 'refs/heads/main',
				targetSha: '2'.repeat(40),
				graphFingerprint: 'e'.repeat(64),
			},
			graphFingerprint: 'e'.repeat(64),
			artifact: { ...definition.artifact, title: 'Changed while active' },
		})

		expect(result).toMatchObject({
			ok: false,
			error: { code: 'active_definition_conflict' },
		})
	})

	it('rejects parent and dependency changes while work is active', async () => {
		const current = { ...record('wc-1'), status: 'in_progress', assignee: 'agent-a' }
		const binary = await writeFakeBinary(`
if (process.argv[2] === 'list') console.log(${JSON.stringify(JSON.stringify([current]))})
else process.exit(9)
`)
		const provider = createBeadsProvider({ root, projectId: 'example', binary })

		await expect(
			provider.setRelations({ workId: 'ISSUE-1', parentId: undefined, dependencies: ['ISSUE-2'] }),
		).resolves.toMatchObject({
			ok: false,
			error: { code: 'active_definition_conflict' },
		})
		await expect(provider.archive('ISSUE-1')).resolves.toMatchObject({
			ok: false,
			error: { code: 'active_definition_conflict' },
		})
	})

	it('atomically upgrades a markerless related schema-v1 batch through one targeted read', async () => {
		const log = join(root, 'commands.log')
		const secondDefinition: LedgerDefinitionInput = {
			...definition,
			artifact: {
				...definition.artifact,
				id: 'ISSUE-2',
				title: 'Second issue',
				source: { path: 'docs/ISSUE-2.md', hash: 'e'.repeat(64) },
				dependencies: ['ISSUE-1'],
			},
		}
		const legacy = [definition, secondDefinition].map((candidate) => ({
			id: exampleProviderId(candidate.artifact.id),
			title: candidate.artifact.title,
			status: 'open',
			priority: 2,
			issue_type: 'issue',
			created_at: '2026-09-01T00:00:00.000Z',
			updated_at: '2026-09-01T00:00:00.000Z',
			metadata: {
				work_contract: {
					schema_version: 1,
					project_id: 'example',
					work_id: candidate.artifact.id,
					kind: 'issue',
					source_path: candidate.artifact.source.path,
					source_hash: candidate.artifact.source.hash,
					graph_fingerprint: candidate.graphFingerprint,
				},
			},
			dependencies:
				candidate.artifact.id === 'ISSUE-2'
					? [
							{
								issue_id: exampleProviderId('ISSUE-2'),
								depends_on_id: exampleProviderId('ISSUE-1'),
								dependency_type: 'blocks',
								metadata: '{}',
							},
						]
					: [],
		}))
		const binary = await writeFakeBinary(`
import { appendFileSync, readFileSync } from 'node:fs'
const args = process.argv.slice(2)
const command = args[0]
appendFileSync(${JSON.stringify(log)}, command + '\\n')
const records = ${JSON.stringify(legacy)}
if (command === 'list') console.log('[]')
else if (command === 'show') console.log(JSON.stringify(records))
else if (command === 'update') {
  const current = records.find(({ id }) => id === args[1])
  const raw = args[args.indexOf('--metadata') + 1]
  const metadata = JSON.parse(raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw)
  console.log(JSON.stringify({ ...current, title: args[args.indexOf('--title') + 1], metadata }))
} else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		await expect(
			provider.createDefinitions?.([definition, secondDefinition]),
		).resolves.toMatchObject({
			ok: true,
			value: [
				{ workId: 'ISSUE-1', definitionSchemaVersion: 2 },
				{
					workId: 'ISSUE-2',
					definitionSchemaVersion: 2,
					dependencies: ['ISSUE-1'],
				},
			],
		})
		await expect(readFile(log, 'utf8')).resolves.toBe('list\nshow\nupdate\nupdate\n')
	})

	it('retries a partially upgraded markerless batch without stranding dependent records', async () => {
		const log = join(root, 'commands.log')
		const state = join(root, 'state.json')
		const failed = join(root, 'failed-once')
		await writeFile(state, '[]')
		const dependency: LedgerDefinitionInput = {
			...definition,
			artifact: {
				...definition.artifact,
				id: 'ISSUE-2',
				title: 'Dependency',
				source: { path: 'docs/ISSUE-2.md', hash: 'e'.repeat(64) },
			},
		}
		const dependent: LedgerDefinitionInput = {
			...definition,
			artifact: {
				...definition.artifact,
				id: 'ISSUE-1',
				title: 'Dependent',
				source: { path: 'docs/ISSUE-1.md', hash: 'f'.repeat(64) },
				dependencies: ['ISSUE-2'],
			},
		}
		const legacy = [dependent, dependency].map((candidate) => ({
			id: exampleProviderId(candidate.artifact.id),
			title: candidate.artifact.title,
			status: 'open',
			priority: 2,
			issue_type: 'issue',
			created_at: '2026-09-01T00:00:00.000Z',
			updated_at: '2026-09-01T00:00:00.000Z',
			metadata: {
				work_contract: {
					schema_version: 1,
					project_id: 'example',
					work_id: candidate.artifact.id,
					kind: 'issue',
					source_path: candidate.artifact.source.path,
					source_hash: candidate.artifact.source.hash,
					graph_fingerprint: candidate.graphFingerprint,
				},
			},
			dependencies:
				candidate.artifact.id === 'ISSUE-1'
					? [
							{
								issue_id: exampleProviderId('ISSUE-1'),
								depends_on_id: exampleProviderId('ISSUE-2'),
								dependency_type: 'blocks',
								metadata: '{}',
							},
						]
					: [],
		}))
		const binary = await writeFakeBinary(`
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const command = args[0]
appendFileSync(${JSON.stringify(log)}, command + (command === 'update' ? ':' + args[1] : '') + '\\n')
const legacy = ${JSON.stringify(legacy)}
const statePath = ${JSON.stringify(state)}
const records = JSON.parse(readFileSync(statePath, 'utf8'))
if (command === 'list') console.log(JSON.stringify(records))
else if (command === 'show') {
  const ids = new Set(args.slice(1))
  console.log(JSON.stringify(legacy.filter(({ id }) => ids.has(id) && !records.some((record) => record.id === id))))
} else if (command === 'update') {
  if (args[1] === ${JSON.stringify(exampleProviderId('ISSUE-1'))} && !existsSync(${JSON.stringify(failed)})) {
    writeFileSync(${JSON.stringify(failed)}, 'failed')
    process.exit(7)
  }
  const current = legacy.find(({ id }) => id === args[1])
  const raw = args[args.indexOf('--metadata') + 1]
  const metadata = JSON.parse(raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw)
  const updated = { ...current, title: args[args.indexOf('--title') + 1], metadata }
  const next = [...records.filter(({ id }) => id !== updated.id), updated]
  writeFileSync(statePath, JSON.stringify(next))
  console.log(JSON.stringify(updated))
} else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		await expect(provider.createDefinitions?.([dependent, dependency])).resolves.toMatchObject({
			ok: false,
			applied: 1,
			failedIndex: 0,
		})
		await expect(provider.createDefinitions?.([dependent, dependency])).resolves.toMatchObject({
			ok: true,
			value: [{ workId: 'ISSUE-1', dependencies: ['ISSUE-2'] }, { workId: 'ISSUE-2' }],
		})
		await expect(readFile(log, 'utf8')).resolves.toContain(
			`update:${exampleProviderId('ISSUE-2')}\nupdate:${exampleProviderId('ISSUE-1')}\n`,
		)
	})

	it('bounds schema diagnostics for adversarial owned metadata', async () => {
		const secret = 'owned-metadata-secret'
		const extras = Object.fromEntries(
			Array.from({ length: 500 }, (_, index) => [`${secret}-${index}`, 'x'.repeat(500)]),
		)
		const malformed = JSON.stringify({
			...record('wc-1'),
			metadata: {
				work_contract_project_key: createHash('sha256').update('example').digest('hex'),
				work_contract: { ...record('wc-1').metadata.work_contract, ...extras },
			},
		})
		const binary = await writeFakeBinary(`console.log(JSON.stringify([${malformed}]))`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.list()

		expect(result).toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_beads_record' },
		})
		const serialized = JSON.stringify(result)
		expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(2048)
		expect(serialized).not.toContain(secret)
	})

	it.each([
		{
			name: 'activity actor',
			metadata: {
				activity: {
					actor: '界'.repeat(43),
					started_at: '2026-09-01T00:00:00.000Z',
					touched_at: '2026-09-01T00:00:00.000Z',
				},
			},
		},
		{
			name: 'handoff summary',
			metadata: {
				handoff: {
					actor: 'agent-a',
					summary: '界'.repeat(1334),
					remaining: [],
					references: [],
					created_at: '2026-09-01T00:00:00.000Z',
				},
			},
		},
		{
			name: 'source path',
			metadata: { source_path: `${'界'.repeat(167)}.md` },
		},
	] as const)('rejects provider $name beyond its UTF-8 byte limit', async ({ metadata }) => {
		const malformed = JSON.stringify({
			...record('wc-1'),
			metadata: {
				work_contract_project_key: createHash('sha256').update('example').digest('hex'),
				work_contract: {
					...record('wc-1').metadata.work_contract,
					...metadata,
				},
			},
		})
		const binary = await writeFakeBinary(`console.log(JSON.stringify([${malformed}]))`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		await expect(provider.list()).resolves.toMatchObject({
			ok: false,
			error: { code: 'invalid_beads_record' },
		})
	})

	it('returns bounded sanitized diagnostics for failed provider processes', async () => {
		const secret = 'provider-secret-material'
		const binary = await writeFakeBinary(`
process.stdout.write(${JSON.stringify(secret)}.repeat(10_000))
process.stderr.write(${JSON.stringify(secret)}.repeat(10_000))
process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.list()

		expect(result).toMatchObject({
			ok: false,
			error: {
				code: 'beads_command_failed',
				message: 'Beads command failed.',
				details: ['exitCode=9'],
			},
		})
		const serialized = JSON.stringify(result)
		expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(1024)
		expect(serialized).not.toContain(secret)
		expect(serialized).not.toContain(binary)
		expect(serialized).not.toContain(root)
	})

	it('does not echo a provider-controlled assignee in ownership errors', async () => {
		const secret = `provider-assignee-${'x'.repeat(96)}`
		const claimed = JSON.stringify({
			...record('wc-1'),
			status: 'in_progress',
			assignee: secret,
		})
		const binary = await writeFakeBinary(
			`if (process.argv[2] === 'list') console.log(JSON.stringify([${claimed}]))\nelse process.exit(9)`,
		)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.claim({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			timestamp: '2026-09-01T00:00:00.000Z',
			dependencyRequirements: [],
		})

		expect(result).toMatchObject({
			ok: false,
			error: { code: 'ownership_conflict' },
		})
		expect(JSON.stringify(result)).not.toContain(secret)
	})

	it('does not echo malformed provider JSON in parse failures', async () => {
		const secret = 'secret-invalid-json-payload'
		const binary = await writeFakeBinary(`process.stdout.write(${JSON.stringify(secret)})`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.list()

		expect(result).toMatchObject({
			ok: false,
			error: {
				code: 'invalid_beads_json',
				message: 'Beads returned malformed JSON.',
			},
		})
		expect(JSON.stringify(result)).not.toContain(secret)
	})

	it('rejects invalid UTF-8 provider output without replacement decoding', async () => {
		const binary = await writeFakeBinary(`
if (process.argv[2] === 'list') process.stdout.write(Buffer.from([0xff]))
else process.exit(9)
`)

		await expect(
			createBeadsProvider({ root, projectId: 'example', binary }).list(),
		).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_beads_json' },
		})
	})

	it('treats invalid UTF-8 after a launched mutation as uncertain', async () => {
		const durableEffect = join(root, 'invalid-utf8-effect')
		const openRecord = JSON.stringify(record('wc-1'))
		const binary = await writeFakeBinary(`
import { writeFileSync } from 'node:fs'
if (process.argv[2] === 'list') console.log(JSON.stringify([${openRecord}]))
else if (process.argv[2] === 'update') {
  writeFileSync(${JSON.stringify(durableEffect)}, 'persisted')
  process.stdout.write(Buffer.from([0xff]))
} else process.exit(9)
`)
		const result = await createBeadsProvider({ root, projectId: 'example', binary }).claim({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			timestamp: '2026-09-01T00:00:00.000Z',
			dependencyRequirements: [],
		})

		expect(result).toMatchObject({ ok: false, error: { code: 'provider_mutation_failed' } })
		if (!result.ok) {
			expect(result.error.details).toContain('failureKind=invalid_utf8')
		}
		await expect(readFile(durableEffect, 'utf8')).resolves.toBe('persisted')
	})

	it('classifies abnormal mutation termination as uncertain without exposing process output', async () => {
		const openRecord = JSON.stringify(record('wc-1'))
		const secret = 'abnormal-provider-secret'
		const binary = await writeFakeBinary(`
if (process.argv[2] === 'list') console.log(JSON.stringify([${openRecord}]))
else if (process.argv[2] === 'update') process.stdout.write(${JSON.stringify(secret)}.repeat(7_000_000))
else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.claim({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			timestamp: '2026-09-01T00:00:00.000Z',
			dependencyRequirements: [],
		})

		expect(result).toMatchObject({
			ok: false,
			error: {
				code: 'provider_mutation_failed',
				message: 'Beads mutation process ended abnormally; provider state is uncertain.',
			},
		})
		if (!result.ok) {
			expect(result.error.details).toContain('operation=update')
			expect(result.error.details).toContain('stateMayHaveChanged=true')
			expect(result.error.details).toContain('failureKind=abnormal_process_exit')
		}
		const serialized = JSON.stringify(result)
		expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(1024)
		expect(serialized).not.toContain(secret)
		expect(serialized).not.toContain(binary)
	})

	it('treats unavailable-looking output from a launched mutation as uncertain', async () => {
		const durableEffect = join(root, 'durable-effect')
		const openRecord = JSON.stringify(record('wc-1'))
		const binary = await writeFakeBinary(`
import { writeFileSync } from 'node:fs'
if (process.argv[2] === 'list') console.log(JSON.stringify([${openRecord}]))
else if (process.argv[2] === 'update') {
  writeFileSync(${JSON.stringify(durableEffect)}, 'persisted')
  process.stderr.write('command not found')
  process.exit(9)
} else process.exit(9)
`)
		const result = await createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		}).claim({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			timestamp: '2026-09-01T00:00:00.000Z',
			dependencyRequirements: [],
		})

		expect(result).toMatchObject({ ok: false, error: { code: 'provider_mutation_failed' } })
		if (!result.ok) {
			expect(result.error.details).toContain('stateMayHaveChanged=true')
		}
		await expect(readFile(durableEffect, 'utf8')).resolves.toBe('persisted')
	})

	it('bounds provider discovery and requests only one sentinel record beyond the limit', async () => {
		const log = join(root, 'commands.log')
		const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join('\\t') + '\\n')
const records = Array.from({ length: 1025 }, (_, index) => ({
  id: 'wc-' + index,
  title: 'Issue ' + index,
  status: 'open',
  priority: 2,
  issue_type: 'task',
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z'
}))
console.log(JSON.stringify(records))
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		await expect(provider.list()).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'beads_item_limit_exceeded' },
		})
		await expect(readFile(log, 'utf8')).resolves.toContain('--limit\t1025')
	})

	it('rejects duplicate project work IDs before caching a mutation target', async () => {
		const canary = 'PRIVATE-999999'
		const duplicate = (providerId: string) => ({
			...record(providerId),
			metadata: {
				...record(providerId).metadata,
				work_contract: {
					...record(providerId).metadata.work_contract,
					work_id: canary,
				},
			},
		})
		const first = JSON.stringify(duplicate('wc-1'))
		const second = JSON.stringify(duplicate('wc-2'))
		const binary = await writeFakeBinary(`
const command = process.argv[2]
const id = process.argv[3]
if (command === 'list') console.log(JSON.stringify([${first}, ${second}]))
else if (command === 'show') console.log(id === 'wc-1' ? ${JSON.stringify(first)} : ${JSON.stringify(second)})
else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.list()
		expect(result).toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_ledger_projection' },
		})
		expect(JSON.stringify(result)).not.toContain(canary)
	})

	it.each([String.raw`C:\private\ISSUE-1.md`, String.raw`..\private\ISSUE-1.md`])(
		'rejects provider source paths outside the provider-neutral contract: %s',
		async (sourcePath) => {
			const unsafe = {
				...record('wc-1'),
				metadata: {
					...record('wc-1').metadata,
					work_contract: {
						...record('wc-1').metadata.work_contract,
						source_path: sourcePath,
					},
				},
			}
			const binary = await writeFakeBinary(
				`if (process.argv[2] === 'list') console.log(${JSON.stringify(JSON.stringify([unsafe]))})\nelse process.exit(9)`,
			)

			await expect(
				createBeadsProvider({ root, projectId: 'example', binary }).list(),
			).resolves.toMatchObject({
				ok: false,
				error: { code: 'invalid_ledger_projection' },
			})
		},
	)

	it('accepts the maximum dependency fanout together with one parent relation', async () => {
		const projectKey = createHash('sha256').update('example').digest('hex')
		const relationMetadata = (workId: string, kind: 'issue' | 'prd' = 'issue') => ({
			work_contract_project_key: projectKey,
			work_contract: {
				...record('embedded', { kind }).metadata.work_contract,
				work_id: workId,
				kind,
				source_path: `docs/${workId}.md`,
			},
		})
		const dependencyRelations = Array.from({ length: 64 }, (_, index) => ({
			issue_id: 'wc-1',
			depends_on_id: `wc-dependency-${index + 1}`,
			type: 'blocks',
			metadata: relationMetadata(`ISSUE-${index + 2}`),
		}))
		const target = {
			...record('wc-1'),
			dependencies: [
				...dependencyRelations,
				{
					issue_id: 'wc-1',
					depends_on_id: 'wc-parent',
					type: 'parent-child',
					metadata: relationMetadata('PRD-1', 'prd'),
				},
			],
		}
		const binary = await writeFakeBinary(
			`if (process.argv[2] === 'list') console.log(${JSON.stringify(JSON.stringify([target]))})\nelse process.exit(9)`,
		)

		const listed = await createBeadsProvider({ root, projectId: 'example', binary }).list()
		expect(listed).toMatchObject({
			ok: true,
			value: [{ workId: 'ISSUE-1', parentId: 'PRD-1' }],
		})
		if (listed.ok) {
			expect(listed.value[0]?.dependencies).toHaveLength(64)
		}
	})

	it('rejects multiple distinct parent relations regardless of provider order', async () => {
		const projectKey = createHash('sha256').update('example').digest('hex')
		const parent = (workId: string) => ({
			issue_id: 'wc-1',
			depends_on_id: `wc-${workId.toLowerCase()}`,
			type: 'parent-child',
			metadata: {
				work_contract_project_key: projectKey,
				work_contract: {
					...record('embedded', { kind: 'prd' }).metadata.work_contract,
					work_id: workId,
					kind: 'prd',
					source_path: `docs/${workId}.md`,
				},
			},
		})
		for (const dependencies of [
			[parent('PRD-1'), parent('PRD-2')],
			[parent('PRD-2'), parent('PRD-1')],
		]) {
			const binary = await writeFakeBinary(
				`if (process.argv[2] === 'list') console.log(${JSON.stringify(JSON.stringify([{ ...record('wc-1'), dependencies }]))})\nelse process.exit(9)`,
			)
			await expect(
				createBeadsProvider({ root, projectId: 'example', binary }).list(),
			).resolves.toMatchObject({
				ok: false,
				error: { code: 'invalid_ledger_projection' },
			})
		}
	})

	it('lets an independent item proceed while another item lock is active', async () => {
		const first = record('wc-1')
		const second = {
			...record('wc-2'),
			metadata: {
				work_contract_project_key: createHash('sha256').update('example').digest('hex'),
				work_contract: {
					...record('wc-2').metadata.work_contract,
					work_id: 'ISSUE-2',
					source_path: 'docs/ISSUE-2.md',
				},
			},
		}
		const claimed = {
			...second,
			status: 'in_progress' as const,
			assignee: 'agent-b',
		}
		const active = {
			...claimed,
			metadata: {
				work_contract_project_key: createHash('sha256').update('example').digest('hex'),
				work_contract: {
					...second.metadata.work_contract,
					activity: {
						actor: 'agent-b',
						session: 'session-b',
						started_at: '2026-09-01T00:00:00.000Z',
						touched_at: '2026-09-01T00:00:00.000Z',
					},
					evidence: [],
				},
			},
		}
		const binary = await writeFakeBinary(`
const args = process.argv.slice(2)
if (args[0] === 'list') console.log(${JSON.stringify(JSON.stringify([first, second]))})
else if (args[0] === 'update' && args.includes('--metadata')) console.log(${JSON.stringify(JSON.stringify(active))})
else if (args[0] === 'update') console.log(${JSON.stringify(JSON.stringify(claimed))})
else process.exit(9)
`)
		await writeFile(
			providerLockPath('example', 'ISSUE-1'),
			`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), nonce: 'active-lock' })}\n`,
		)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const startedAt = performance.now()
		const result = await provider.claim({
			workId: 'ISSUE-2',
			actor: 'agent-b',
			session: 'session-b',
			timestamp: '2026-09-01T00:00:00.000Z',
			dependencyRequirements: [],
		})

		expect(result).toMatchObject({ ok: true, value: { workId: 'ISSUE-2' } })
		expect(performance.now() - startedAt).toBeLessThan(3000)
	})

	it('fails closed and preserves a dead item-lock generation', async () => {
		const openRecord = record('wc-1')
		const claimed = {
			...openRecord,
			status: 'in_progress' as const,
			assignee: 'agent-a',
		}
		const active = {
			...claimed,
			metadata: {
				work_contract_project_key: createHash('sha256').update('example').digest('hex'),
				work_contract: {
					...openRecord.metadata.work_contract,
					activity: {
						actor: 'agent-a',
						session: 'session-a',
						started_at: '2026-09-01T00:00:00.000Z',
						touched_at: '2026-09-01T00:00:00.000Z',
					},
					evidence: [],
				},
			},
		}
		const binary = await writeFakeBinary(`
const args = process.argv.slice(2)
if (args[0] === 'list') console.log(${JSON.stringify(JSON.stringify([openRecord]))})
else if (args[0] === 'update' && args.includes('--metadata')) console.log(${JSON.stringify(JSON.stringify(active))})
else if (args[0] === 'update') console.log(${JSON.stringify(JSON.stringify(claimed))})
else process.exit(9)
`)
		const lockPath = providerLockPath('example', 'ISSUE-1')
		const replacement = `${JSON.stringify({
			pid: 2_147_483_647,
			startedAt: '2026-09-01T00:00:00.000Z',
			nonce: 'replacement-generation',
		})}\n`
		await writeFile(lockPath, replacement)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.claim({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			session: 'session-a',
			timestamp: '2026-09-01T00:00:00.000Z',
			dependencyRequirements: [],
		})
		expect(result).toMatchObject({
			ok: false,
			error: {
				code: 'provider_busy',
				message: 'A stale provider mutation lock requires manual recovery.',
			},
		})
		await expect(readFile(lockPath, 'utf8')).resolves.toBe(replacement)
	})

	it('fails closed on the exact legacy dead-PID lock format', async () => {
		const openRecord = record('wc-1')
		const claimed = {
			...openRecord,
			status: 'in_progress' as const,
			assignee: 'agent-a',
		}
		const active = {
			...claimed,
			metadata: {
				work_contract_project_key: createHash('sha256').update('example').digest('hex'),
				work_contract: {
					...openRecord.metadata.work_contract,
					activity: {
						actor: 'agent-a',
						started_at: '2026-09-01T00:00:00.000Z',
						touched_at: '2026-09-01T00:00:00.000Z',
					},
					evidence: [],
				},
			},
		}
		const binary = await writeFakeBinary(`
const args = process.argv.slice(2)
if (args[0] === 'list') console.log(${JSON.stringify(JSON.stringify([openRecord]))})
else if (args[0] === 'update' && args.includes('--metadata')) console.log(${JSON.stringify(JSON.stringify(active))})
else if (args[0] === 'update') console.log(${JSON.stringify(JSON.stringify(claimed))})
else process.exit(9)
`)
		const lockPath = legacyProviderLockPath('example')
		await writeFile(lockPath, '2147483647\n')
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.claim({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			timestamp: '2026-09-01T00:00:00.000Z',
			dependencyRequirements: [],
		})

		expect(result).toMatchObject({
			ok: false,
			error: {
				code: 'provider_busy',
				message: 'A stale provider mutation lock requires manual recovery.',
			},
		})
		await expect(readFile(lockPath, 'utf8')).resolves.toBe('2147483647\n')
	})

	it.each([
		{ kind: 'oversized' as const, code: 'provider_busy' },
		{ kind: 'symlink' as const, code: 'unsafe_provider_lock' },
	])(
		'preserves an $kind repository-controlled item lock without reading its payload',
		async ({ kind, code }) => {
			const privateCanary = 'PRIVATE_LOCK_CANARY'
			const binary = await writeFakeBinary('process.exit(9)')
			const lockPath = providerLockPath('example', 'ISSUE-1')
			const targetPath = join(root, 'lock-target')
			if (kind === 'oversized') {
				await writeFile(lockPath, `${privateCanary}${'x'.repeat(513)}`)
			} else {
				await writeFile(targetPath, privateCanary)
				await symlink(targetPath, lockPath)
			}
			const provider = createBeadsProvider({
				root,
				projectId: 'example',
				binary,
			})

			const result = await provider.claim({
				workId: 'ISSUE-1',
				actor: 'agent-a',
				timestamp: '2026-09-01T00:00:00.000Z',
				dependencyRequirements: [],
			})

			expect(result).toMatchObject({ ok: false, error: { code } })
			expect(JSON.stringify(result)).not.toContain(privateCanary)
			expect(JSON.stringify(result)).not.toContain(root)
			if (kind === 'oversized') {
				await expect(readFile(lockPath, 'utf8')).resolves.toContain(privateCanary)
			} else {
				await expect(readFile(targetPath, 'utf8')).resolves.toBe(privateCanary)
			}
		},
	)

	it('preserves a primary provider error when owned-lock cleanup also fails', async () => {
		const lockPath = providerLockPath('example', 'ISSUE-1')
		const replacement = 'replacement-generation-secret\n'
		const binary = await writeFakeBinary(`
import { writeFileSync } from 'node:fs'
if (process.argv[2] === 'list') {
  writeFileSync(${JSON.stringify(lockPath)}, ${JSON.stringify(replacement)})
  process.stderr.write('private-provider-diagnostic')
  process.exit(9)
}
process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.claim({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			timestamp: '2026-09-01T00:00:00.000Z',
			dependencyRequirements: [],
		})

		expect(result).toMatchObject({
			ok: false,
			error: {
				code: 'beads_command_failed',
				message: 'Beads command failed.',
			},
		})
		if (!result.ok) {
			expect(result.error.details).toContain('exitCode=9')
			expect(result.error.details).toContain('cleanupFailure=provider_lock_release_failed')
			expect(result.error.details).toContain(
				'recovery=preserve the primary error and inspect the provider mutation lock manually',
			)
		}
		expect(JSON.stringify(result)).not.toContain('private-provider-diagnostic')
		await expect(readFile(lockPath, 'utf8')).resolves.toBe(replacement)
	})

	it('reconstructs relation-shaped dependencies for an arbitrary graph with one list process', async () => {
		const log = join(root, 'commands.log')
		const records = Array.from({ length: 40 }, (_, index) => {
			const providerId = `wc-${index}`
			const workId = `ISSUE-${index}`
			return {
				...record(providerId),
				metadata: {
					work_contract_project_key: createHash('sha256').update('example').digest('hex'),
					work_contract: {
						...record(providerId).metadata.work_contract,
						work_id: workId,
						source_path: `docs/${workId}.md`,
					},
				},
				...(index === 0
					? {}
					: {
							dependencies: [
								{
									issue_id: providerId,
									depends_on_id: `wc-${index - 1}`,
									type: 'blocks',
								},
							],
						}),
			}
		})
		const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join('\\t') + '\\n')
if (process.argv[2] === 'list') console.log(${JSON.stringify(JSON.stringify(records))})
else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const listed = await provider.list()

		expect(listed.ok, JSON.stringify(listed)).toBe(true)
		if (!listed.ok) {
			return
		}
		expect(listed.value.find(({ workId }) => workId === 'ISSUE-39')?.dependencies).toStrictEqual([
			'ISSUE-38',
		])
		const graphCommands = await readFile(log, 'utf8')
		expect(graphCommands.trim().split('\n')).toHaveLength(1)
	})

	it('fails closed when an owned item has an unresolved outbound relation', async () => {
		const owned = {
			...record('wc-1'),
			dependencies: [
				{
					issue_id: 'wc-1',
					depends_on_id: 'foreign-provider-id',
					type: 'blocks',
				},
			],
		}
		const binary = await writeFakeBinary(`console.log(${JSON.stringify(JSON.stringify([owned]))})`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		await expect(provider.list()).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_ledger_projection' },
		})
	})

	it('enforces role and session assertions before mutation and preserves completion attribution', async () => {
		const log = join(root, 'commands.log')
		const active = {
			...record('wc-1'),
			status: 'in_progress' as const,
			assignee: 'agent-a',
			metadata: {
				work_contract_project_key: createHash('sha256').update('example').digest('hex'),
				work_contract: {
					...record('wc-1').metadata.work_contract,
					activity: {
						actor: 'agent-a',
						role: 'implementer',
						session: 'session-a',
						started_at: '2026-09-01T00:00:00.000Z',
						touched_at: '2026-09-01T00:00:00.000Z',
					},
				},
			},
		}
		const completed = { ...active, status: 'closed' as const }
		const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(log)}, args.join('\\t') + '\\n')
if (args[0] === 'list') console.log(${JSON.stringify(JSON.stringify([active]))})
else if (args[0] === 'comment') console.log('{}')
else if (args[0] === 'update') console.log(${JSON.stringify(JSON.stringify(active))})
else if (args[0] === 'close') console.log(${JSON.stringify(JSON.stringify(completed))})
else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const mismatch = await provider.transition({
			type: 'complete',
			workId: 'ISSUE-1',
			actor: 'agent-a',
			role: 'reviewer',
			session: 'session-a',
			evidence: [],
			timestamp: '2026-09-01T01:00:00.000Z',
			dependencyRequirements: [],
		})
		expect(mismatch, JSON.stringify(mismatch)).toMatchObject({
			ok: false,
			error: { code: 'role_conflict' },
		})
		const mismatchCommands = await readFile(log, 'utf8')
		expect(mismatchCommands.trim().split('\n')).toHaveLength(1)

		await writeFile(log, '')
		const sessionMismatch = await provider.transition({
			type: 'complete',
			workId: 'ISSUE-1',
			actor: 'agent-a',
			role: 'implementer',
			session: 'session-b',
			evidence: [],
			timestamp: '2026-09-01T01:00:00.000Z',
			dependencyRequirements: [],
		})
		expect(sessionMismatch, JSON.stringify(sessionMismatch)).toMatchObject({
			ok: false,
			error: { code: 'session_conflict' },
		})
		const sessionMismatchCommands = await readFile(log, 'utf8')
		expect(sessionMismatchCommands.trim().split('\n')).toHaveLength(1)

		await writeFile(log, '')
		const result = await provider.transition({
			type: 'complete',
			workId: 'ISSUE-1',
			actor: 'agent-a',
			role: 'implementer',
			session: 'session-a',
			evidence: [],
			timestamp: '2026-09-01T01:00:00.000Z',
			dependencyRequirements: [],
		})

		expect(result, JSON.stringify(result)).toMatchObject({
			ok: true,
			value: {
				status: 'closed',
				activity: {
					actor: 'agent-a',
					role: 'implementer',
					session: 'session-a',
				},
			},
		})
		const commandSource = await readFile(log, 'utf8')
		const commands = commandSource.trim().split('\n')
		expect(commands).toHaveLength(3)
		expect(commands[1]).toContain('update\twc-1\t--metadata')
		expect(commands[1]).toContain('--append-notes\twork-contract:complete-intent:v1')
		expect(commands[2]).toContain('close\twc-1')
		expect(commands[2]).toContain('--session\tsession-a')
		expect(commands.some((command) => command.startsWith('show\t'))).toBe(false)
	})

	it('treats only an exact active re-claim as idempotent', async () => {
		const log = join(root, 'commands.log')
		const active = {
			...record('wc-1'),
			status: 'in_progress',
			assignee: 'agent-a',
			metadata: {
				work_contract_project_key: createHash('sha256').update('example').digest('hex'),
				work_contract: {
					...record('wc-1').metadata.work_contract,
					activity: {
						actor: 'agent-a',
						role: 'implementer',
						session: 'session-a',
						started_at: '2026-09-01T00:00:00.000Z',
						touched_at: '2026-09-01T00:00:00.000Z',
					},
				},
			},
		}
		const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(log)}, process.argv[2] + '\\n')
if (process.argv[2] === 'list') console.log(${JSON.stringify(JSON.stringify([active]))})
else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		await expect(
			provider.claim({
				workId: 'ISSUE-1',
				actor: 'agent-a',
				role: 'implementer',
				session: 'session-a',
				timestamp: '2026-09-01T01:00:00.000Z',
			}),
		).resolves.toMatchObject({
			ok: true,
			value: {
				activity: {
					role: 'implementer',
					session: 'session-a',
					startedAt: '2026-09-01T00:00:00.000Z',
				},
			},
		})
		await expect(
			provider.claim({
				workId: 'ISSUE-1',
				actor: 'agent-a',
				role: 'reviewer',
				session: 'session-a',
				timestamp: '2026-09-01T01:00:00.000Z',
			}),
		).resolves.toMatchObject({ ok: false, error: { code: 'role_conflict' } })
		await expect(
			provider.claim({
				workId: 'ISSUE-1',
				actor: 'agent-a',
				role: 'implementer',
				session: 'session-b',
				timestamp: '2026-09-01T01:00:00.000Z',
			}),
		).resolves.toMatchObject({
			ok: false,
			error: { code: 'session_conflict' },
		})
		await expect(readFile(log, 'utf8')).resolves.toBe('list\nlist\nlist\n')
	})

	it.each(['blocked', 'closed', 'deferred', 'archived'] as const)(
		'rejects a direct claim from %s before invoking a provider mutation',
		async (status) => {
			const log = join(root, 'commands.log')
			const item = {
				...record('wc-1'),
				status: status === 'archived' ? 'closed' : status,
				...(status === 'archived'
					? {
							metadata: {
								work_contract_project_key: createHash('sha256').update('example').digest('hex'),
								work_contract: {
									...record('wc-1').metadata.work_contract,
									archived: true,
								},
							},
						}
					: {}),
			}
			const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(log)}, process.argv[2] + '\\n')
if (process.argv[2] === 'list') console.log(${JSON.stringify(JSON.stringify([item]))})
else process.exit(9)
`)
			const provider = createBeadsProvider({
				root,
				projectId: 'example',
				binary,
			})

			await expect(
				provider.claim({
					workId: 'ISSUE-1',
					actor: 'agent-a',
					timestamp: '2026-09-01T01:00:00.000Z',
				}),
			).resolves.toMatchObject({
				ok: false,
				error: { code: 'invalid_transition' },
			})
			await expect(readFile(log, 'utf8')).resolves.toBe('list\n')
		},
	)

	it('uses authoritative update output without a redundant read after a successful claim', async () => {
		const log = join(root, 'commands.log')
		const openRecord = record('wc-1')
		const activeRecord = {
			...openRecord,
			status: 'in_progress' as const,
			assignee: 'agent-a',
			metadata: {
				work_contract_project_key: createHash('sha256').update('example').digest('hex'),
				work_contract: {
					...openRecord.metadata.work_contract,
					activity: {
						actor: 'agent-a',
						role: 'implementer',
						session: 'session-a',
						started_at: '2026-09-01T00:00:00.000Z',
						touched_at: '2026-09-01T00:00:00.000Z',
					},
				},
			},
		}
		const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(log)}, args.join('\\t') + '\\n')
if (args[0] === 'list') console.log(${JSON.stringify(JSON.stringify([openRecord]))})
else if (args[0] === 'update' && args.includes('--metadata')) console.log(${JSON.stringify(JSON.stringify(activeRecord))})
else if (args[0] === 'update') console.log(${JSON.stringify(JSON.stringify(activeRecord))})
else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const claimed = await provider.claim({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			role: 'implementer',
			session: 'session-a',
			timestamp: '2026-09-01T00:00:00.000Z',
			dependencyRequirements: [],
		})

		expect(claimed).toMatchObject({
			ok: true,
			value: { activity: { role: 'implementer', session: 'session-a' } },
		})
		const commandSource = await readFile(log, 'utf8')
		const commands = commandSource.trim().split('\n')
		expect(commands).toHaveLength(3)
		expect(commands.filter((command) => command.startsWith('list\t'))).toHaveLength(1)
	})

	it('retains established relations when Beads update output omits relation fields', async () => {
		const parent = {
			...record('wc-parent', { kind: 'prd' }),
			metadata: {
				work_contract_project_key: createHash('sha256').update('example').digest('hex'),
				work_contract: {
					...record('wc-parent', { kind: 'prd' }).metadata.work_contract,
					work_id: 'PRD-1',
					kind: 'prd',
					source_path: 'docs/PRD-1.md',
				},
			},
		}
		const openRecord = {
			...record('wc-1'),
			dependencies: [{ issue_id: 'wc-1', depends_on_id: 'wc-parent', type: 'parent-child' }],
		}
		const activeRecord = {
			...record('wc-1'),
			status: 'in_progress' as const,
			assignee: 'agent-a',
			metadata: {
				work_contract_project_key: createHash('sha256').update('example').digest('hex'),
				work_contract: {
					...openRecord.metadata.work_contract,
					activity: {
						actor: 'agent-a',
						role: 'implementer',
						session: 'session-a',
						started_at: '2026-09-01T00:00:00.000Z',
						touched_at: '2026-09-01T00:00:00.000Z',
					},
				},
			},
		}
		const binary = await writeFakeBinary(`
const args = process.argv.slice(2)
if (args[0] === 'list') console.log(${JSON.stringify(JSON.stringify([openRecord, parent]))})
else if (args[0] === 'update') console.log(${JSON.stringify(JSON.stringify(activeRecord))})
else process.exit(9)
`)
		const provider = createBeadsProvider({ root, projectId: 'example', binary })

		const claimed = await provider.claim({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			role: 'implementer',
			session: 'session-a',
			timestamp: '2026-09-01T00:00:00.000Z',
			expectedDefinition: { ...expectedDefinition, parentId: 'PRD-1' },
			expectedDependencies: [],
		})

		expect(claimed).toMatchObject({
			ok: true,
			value: { parentId: 'PRD-1', dependencies: [] },
		})
	})

	it('fails uncertain when claim metadata output does not confirm the requested activity', async () => {
		const openRecord = record('wc-1')
		const claimedRecord = {
			...openRecord,
			status: 'in_progress' as const,
			assignee: 'agent-a',
		}
		const binary = await writeFakeBinary(`
const args = process.argv.slice(2)
if (args[0] === 'list') console.log(${JSON.stringify(JSON.stringify([openRecord]))})
else if (args[0] === 'update') console.log(${JSON.stringify(JSON.stringify(claimedRecord))})
else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.claim({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			role: 'implementer',
			session: 'session-a',
			timestamp: '2026-09-01T00:00:00.000Z',
			dependencyRequirements: [],
		})

		expect(result).toMatchObject({
			ok: false,
			error: {
				code: 'provider_mutation_failed',
			},
		})
		if (!result.ok) {
			expect(result.error.details).toContain('operation=claim')
			expect(result.error.details).toContain('stateMayHaveChanged=true')
		}
	})

	it('repairs an interrupted same-actor claim without issuing another native claim', async () => {
		const log = join(root, 'commands.log')
		const incomplete = {
			...record('wc-1'),
			status: 'in_progress' as const,
			assignee: 'agent-a',
		}
		const repaired = {
			...incomplete,
			metadata: {
				work_contract_project_key: createHash('sha256').update('example').digest('hex'),
				work_contract: {
					...incomplete.metadata.work_contract,
					activity: {
						actor: 'agent-a',
						role: 'implementer',
						session: 'session-a',
						started_at: '2026-09-01T00:00:00.000Z',
						touched_at: '2026-09-01T00:00:00.000Z',
					},
				},
			},
		}
		const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(log)}, args.join('\\t') + '\\n')
if (args[0] === 'list') console.log(${JSON.stringify(JSON.stringify([incomplete]))})
else if (args[0] === 'update' && args.includes('--metadata')) console.log(${JSON.stringify(JSON.stringify(repaired))})
else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.claim({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			role: 'implementer',
			session: 'session-a',
			timestamp: '2026-09-01T00:00:00.000Z',
			dependencyRequirements: [],
		})

		expect(result).toMatchObject({
			ok: true,
			value: {
				activity: {
					actor: 'agent-a',
					role: 'implementer',
					session: 'session-a',
				},
			},
		})
		const commands = await readFile(log, 'utf8')
		expect(commands.trim().split('\n')).toHaveLength(2)
		expect(commands).not.toContain('--claim')
	})

	it.each([
		{ dependencyStatus: 'open' as const, evidenceRequirements: [] },
		{
			dependencyStatus: 'closed' as const,
			evidenceRequirements: ['test'] as const,
		},
	])(
		'rejects claim and completion when a $dependencyStatus dependency lacks required readiness',
		async ({ dependencyStatus, evidenceRequirements }) => {
			const log = join(root, 'commands.log')
			const dependency = {
				...record('wc-2', { status: dependencyStatus }),
				metadata: {
					work_contract_project_key: createHash('sha256').update('example').digest('hex'),
					work_contract: {
						...record('wc-2').metadata.work_contract,
						work_id: 'ISSUE-2',
						source_path: 'docs/ISSUE-2.md',
						evidence: [],
						evidence_requirements: [...evidenceRequirements],
					},
				},
			}
			const target = {
				...record('wc-1'),
				status: 'in_progress' as const,
				assignee: 'agent-a',
				dependencies: [{ issue_id: 'wc-1', depends_on_id: 'wc-2', type: 'blocks' }],
				metadata: {
					work_contract_project_key: createHash('sha256').update('example').digest('hex'),
					work_contract: {
						...record('wc-1').metadata.work_contract,
						activity: {
							actor: 'agent-a',
							session: 'session-a',
							started_at: '2026-09-01T00:00:00.000Z',
							touched_at: '2026-09-01T00:00:00.000Z',
						},
					},
				},
			}
			const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(log)}, process.argv[2] + '\\n')
if (process.argv[2] === 'list') console.log(${JSON.stringify(JSON.stringify([target, dependency]))})
else process.exit(9)
`)
			const provider = createBeadsProvider({
				root,
				projectId: 'example',
				binary,
			})
			const dependencyRequirements = [
				{ workId: 'ISSUE-2', evidenceRequirements: [...evidenceRequirements] },
			]

			const claim = await provider.claim({
				workId: 'ISSUE-1',
				actor: 'agent-a',
				session: 'session-a',
				timestamp: '2026-09-01T01:00:00.000Z',
				dependencyRequirements,
			})
			const complete = await provider.transition({
				type: 'complete',
				workId: 'ISSUE-1',
				actor: 'agent-a',
				session: 'session-a',
				evidence: [],
				timestamp: '2026-09-01T01:00:00.000Z',
				dependencyRequirements,
			})

			expect(claim).toMatchObject({
				ok: false,
				error: { code: 'work_not_ready' },
			})
			expect(complete).toMatchObject({
				ok: false,
				error: { code: 'work_not_ready' },
			})
			const commands = await readFile(log, 'utf8')
			expect(commands.trim().split('\n')).toStrictEqual(['list', 'list'])
		},
	)

	it('rejects dependency requirements that do not exactly match ledger relations', async () => {
		const target = {
			...record('wc-1'),
			dependencies: [{ issue_id: 'wc-1', depends_on_id: 'wc-2', type: 'blocks' }],
		}
		const dependency = {
			...record('wc-2', { status: 'closed' }),
			metadata: {
				work_contract_project_key: createHash('sha256').update('example').digest('hex'),
				work_contract: {
					...record('wc-2').metadata.work_contract,
					work_id: 'ISSUE-2',
					source_path: 'docs/ISSUE-2.md',
				},
			},
		}
		const binary = await writeFakeBinary(
			`console.log(${JSON.stringify(JSON.stringify([target, dependency]))})`,
		)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.claim({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			timestamp: '2026-09-01T00:00:00.000Z',
			dependencyRequirements: [],
		})

		expect(result).toMatchObject({
			ok: false,
			error: { code: 'ledger_not_synchronized' },
		})
	})

	it('rejects tampered provider dependency policy even when the dependency is closed', async () => {
		const target = {
			...record('wc-1'),
			dependencies: [{ issue_id: 'wc-1', depends_on_id: 'wc-2', type: 'blocks' }],
		}
		const dependency = {
			...record('wc-2', { status: 'closed' }),
			metadata: {
				work_contract_project_key: createHash('sha256').update('example').digest('hex'),
				work_contract: {
					...record('wc-2').metadata.work_contract,
					work_id: 'ISSUE-2',
					source_path: 'docs/ISSUE-2.md',
					evidence_requirements: [],
				},
			},
		}
		const binary = await writeFakeBinary(
			`console.log(${JSON.stringify(JSON.stringify([target, dependency]))})`,
		)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.claim({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			timestamp: '2026-09-01T00:00:00.000Z',
			expectedDependencies: [
				{
					...expectedDefinition,
					workId: 'ISSUE-2',
					source: { ...expectedDefinition.source, path: 'docs/ISSUE-2.md' },
					evidenceRequirements: ['test'],
				},
			],
		})

		expect(result).toMatchObject({
			ok: false,
			error: { code: 'ledger_not_synchronized' },
		})
	})

	it('locks every dependency requirement before reading readiness or mutating the target', async () => {
		const log = join(root, 'commands.log')
		const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(log)}, 'invoked\\n')
process.exit(9)
`)
		const dependencyLock = providerLockPath('example', 'ISSUE-2')
		await writeFile(
			dependencyLock,
			`${JSON.stringify({ pid: 2_147_483_647, startedAt: '2026-09-01T00:00:00.000Z', nonce: 'dead-dependency-generation' })}\n`,
		)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.claim({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			timestamp: '2026-09-01T00:00:00.000Z',
			dependencyRequirements: [{ workId: 'ISSUE-2', evidenceRequirements: [] }],
		})

		expect(result).toMatchObject({
			ok: false,
			error: { code: 'provider_busy' },
		})
		await expect(readFile(log, 'utf8')).rejects.toThrow('ENOENT')
		await expect(readFile(dependencyLock, 'utf8')).resolves.toContain('dead-dependency-generation')
	})

	it('does not report completion when close output omits the requested evidence receipt', async () => {
		const openRecord = record('wc-1')
		const activeRecord = {
			...openRecord,
			status: 'in_progress' as const,
			assignee: 'agent-a',
			metadata: {
				work_contract_project_key: createHash('sha256').update('example').digest('hex'),
				work_contract: {
					...openRecord.metadata.work_contract,
					activity: {
						actor: 'agent-a',
						role: 'implementer',
						session: 'session-a',
						started_at: '2026-09-01T00:00:00.000Z',
						touched_at: '2026-09-01T00:00:00.000Z',
					},
				},
			},
		}
		const closedWithoutEvidence = {
			...activeRecord,
			status: 'closed' as const,
		}
		const binary = await writeFakeBinary(`
const args = process.argv.slice(2)
if (args[0] === 'list') console.log(${JSON.stringify(JSON.stringify([activeRecord]))})
else if (args[0] === 'comment') console.log('{}')
else if (args[0] === 'update') console.log(${JSON.stringify(JSON.stringify(activeRecord))})
else if (args[0] === 'close') console.log(${JSON.stringify(JSON.stringify(closedWithoutEvidence))})
else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.transition({
			type: 'complete',
			workId: 'ISSUE-1',
			actor: 'agent-a',
			role: 'implementer',
			session: 'session-a',
			evidence: [
				{
					kind: 'test',
					reference: 'evidence/proof.json',
					digest: 'c'.repeat(64),
					recordedAt: '2026-09-01T01:00:00.000Z',
					actor: 'agent-a',
				},
			],
			timestamp: '2026-09-01T01:00:00.000Z',
			dependencyRequirements: [],
		})

		expect(result).toMatchObject({
			ok: false,
			error: {
				code: 'provider_mutation_failed',
			},
		})
		if (!result.ok) {
			expect(result.error.details).toContain('operation=complete')
			expect(result.error.details).toContain('stateMayHaveChanged=true')
		}
	})

	it('accepts a completion that persists before the close process exits nonzero', async () => {
		const statePath = join(root, 'state.json')
		const log = join(root, 'commands.log')
		const activeRecord = {
			...record('wc-1'),
			status: 'in_progress' as const,
			assignee: 'agent-a',
			metadata: {
				...record('wc-1').metadata,
				work_contract: {
					...record('wc-1').metadata.work_contract,
					activity: {
						actor: 'agent-a',
						session: 'session-a',
						started_at: '2026-09-01T00:00:00.000Z',
						touched_at: '2026-09-01T00:00:00.000Z',
					},
				},
			},
		}
		await writeFile(statePath, JSON.stringify(activeRecord))
		const binary = await writeFakeBinary(`
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const command = args[0]
appendFileSync(${JSON.stringify(log)}, command + '\\n')
const current = JSON.parse(readFileSync(${JSON.stringify(statePath)}, 'utf8'))
if (command === 'list') console.log(JSON.stringify([current]))
else if (command === 'comment') console.log('{}')
else if (command === 'update') {
  const updated = { ...current, metadata: JSON.parse(args[args.indexOf('--metadata') + 1]) }
  writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(updated))
  console.log(JSON.stringify(updated))
} else if (command === 'close') {
  writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({ ...current, status: 'closed' }))
  process.exit(9)
} else process.exit(9)
`)
		const evidence = [
			{
				kind: 'test' as const,
				reference: 'evidence/proof.json',
				digest: 'c'.repeat(64),
				recordedAt: '2026-09-01T01:00:00.000Z',
				actor: 'agent-a',
			},
		]

		const result = await createBeadsProvider({ root, projectId: 'example', binary }).transition({
			type: 'complete',
			workId: 'ISSUE-1',
			actor: 'agent-a',
			session: 'session-a',
			evidence,
			timestamp: '2026-09-01T01:00:00.000Z',
			dependencyRequirements: [],
		})

		expect(result).toMatchObject({ ok: true, value: { status: 'closed', evidence } })
		await expect(readFile(log, 'utf8')).resolves.toBe('list\nupdate\nclose\nlist\n')
	})

	it('accepts an archive that persists before the close process exits nonzero', async () => {
		const statePath = join(root, 'state.json')
		const log = join(root, 'commands.log')
		await writeFile(statePath, JSON.stringify(record('wc-1')))
		const binary = await writeFakeBinary(`
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const command = args[0]
appendFileSync(${JSON.stringify(log)}, command + '\\n')
const current = JSON.parse(readFileSync(${JSON.stringify(statePath)}, 'utf8'))
if (command === 'list') console.log(JSON.stringify([current]))
else if (command === 'update') {
  const updated = { ...current, metadata: JSON.parse(args[args.indexOf('--metadata') + 1]) }
  writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(updated))
  console.log(JSON.stringify(updated))
} else if (command === 'close') {
  writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({ ...current, status: 'closed' }))
  process.exit(9)
} else process.exit(9)
`)

		const result = await createBeadsProvider({ root, projectId: 'example', binary }).archive(
			'ISSUE-1',
		)

		expect(result).toMatchObject({ ok: true, value: { status: 'archived' } })
		await expect(readFile(log, 'utf8')).resolves.toBe('list\nupdate\nclose\nlist\n')
	})

	it('does not report activity persistence when update output omits the requested timestamp', async () => {
		const activeRecord = {
			...record('wc-1'),
			status: 'in_progress' as const,
			assignee: 'agent-a',
			metadata: {
				work_contract_project_key: createHash('sha256').update('example').digest('hex'),
				work_contract: {
					...record('wc-1').metadata.work_contract,
					activity: {
						actor: 'agent-a',
						started_at: '2026-09-01T00:00:00.000Z',
						touched_at: '2026-09-01T00:00:00.000Z',
					},
				},
			},
		}
		const binary = await writeFakeBinary(`
if (process.argv[2] === 'list') console.log(${JSON.stringify(JSON.stringify([activeRecord]))})
else if (process.argv[2] === 'update') console.log(${JSON.stringify(JSON.stringify(activeRecord))})
else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.recordActivity({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			activity: {
				actor: 'agent-a',
				startedAt: '2026-09-01T00:00:00.000Z',
				touchedAt: '2026-09-01T01:00:00.000Z',
			},
		})

		expect(result).toMatchObject({
			ok: false,
			error: {
				code: 'provider_mutation_failed',
			},
		})
		if (!result.ok) {
			expect(result.error.details).toContain('operation=recordActivity')
			expect(result.error.details).toContain('stateMayHaveChanged=true')
		}
	})

	it.each([
		{ label: 'matching plus unrelated', providerIds: ['wc-1', 'wc-2'] },
		{ label: 'duplicate matching', providerIds: ['wc-1', 'wc-1'] },
	])('rejects $label records in one mutation response', async ({ providerIds }) => {
		const activeRecord = {
			...record('wc-1'),
			status: 'in_progress' as const,
			assignee: 'agent-a',
			metadata: {
				work_contract_project_key: createHash('sha256').update('example').digest('hex'),
				work_contract: {
					...record('wc-1').metadata.work_contract,
					activity: {
						actor: 'agent-a',
						started_at: '2026-09-01T00:00:00.000Z',
						touched_at: '2026-09-01T00:00:00.000Z',
					},
				},
			},
		}
		const mutationRecords = providerIds.map((providerId) => ({
			...activeRecord,
			id: providerId,
			metadata: {
				...activeRecord.metadata,
				work_contract: {
					...activeRecord.metadata.work_contract,
					work_id: providerId === 'wc-1' ? 'ISSUE-1' : 'ISSUE-2',
					source_path: providerId === 'wc-1' ? 'docs/ISSUE-1.md' : 'docs/ISSUE-2.md',
					activity: {
						...activeRecord.metadata.work_contract.activity,
						touched_at: '2026-09-01T01:00:00.000Z',
					},
				},
			},
		}))
		const binary = await writeFakeBinary(`
if (process.argv[2] === 'list') console.log(${JSON.stringify(JSON.stringify([activeRecord]))})
else if (process.argv[2] === 'update') console.log(${JSON.stringify(JSON.stringify(mutationRecords))})
else process.exit(9)
`)
		const provider = createBeadsProvider({ root, projectId: 'example', binary })

		const result = await provider.recordActivity({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			activity: {
				actor: 'agent-a',
				startedAt: '2026-09-01T00:00:00.000Z',
				touchedAt: '2026-09-01T01:00:00.000Z',
			},
		})

		expect(result).toMatchObject({
			ok: false,
			error: { code: 'provider_mutation_failed' },
		})
		if (!result.ok) {
			expect(result.error.details).toContain('operation=recordActivity')
			expect(result.error.details).toContain('providerCode=invalid_beads_record')
		}
	})

	it('does not authorize create when the absence lookup fails', async () => {
		const log = join(root, 'commands.log')
		const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(log)}, process.argv[2] + '\\n')
if (process.argv[2] === 'list') console.log('not-json')
else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		await expect(provider.createDefinition(definition)).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_beads_json' },
		})
		const commands = await readFile(log, 'utf8')
		expect(commands.trim().split('\n')).toStrictEqual(['list'])
	})

	it('does not authorize create when an exact legacy absence lookup fails', async () => {
		const log = join(root, 'commands.log')
		const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(log)}, process.argv[2] + '\\n')
if (process.argv[2] === 'list') console.log('[]')
else if (process.argv[2] === 'show') {
  process.stderr.write('transient provider failure')
  process.exit(9)
} else process.exit(9)
`)
		const provider = createBeadsProvider({ root, projectId: 'example', binary })

		await expect(provider.createDefinition(definition)).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'beads_command_failed' },
		})
		await expect(readFile(log, 'utf8')).resolves.toBe('list\nshow\n')
	})

	it('admits a definition batch with one authoritative list projection', async () => {
		const log = join(root, 'commands.log')
		const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
const command = args[0]
appendFileSync(${JSON.stringify(log)}, command + '\\n')
const value = (name) => args[args.indexOf(name) + 1]
if (command === 'list') console.log('[]')
else if (command === 'show') {
  console.log(JSON.stringify({ error: 'no issues found matching the provided IDs', schema_version: 1 }))
  process.exitCode = 1
}
else if (command === 'create') {
  console.log(JSON.stringify({
    id: value('--id'),
    title: value('--title'),
    status: 'open',
    priority: 2,
    issue_type: value('--type'),
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    metadata: JSON.parse(value('--metadata')),
  }))
} else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})
		const secondDefinition: LedgerDefinitionInput = {
			...definition,
			artifact: {
				...definition.artifact,
				id: 'ISSUE-2',
				title: 'Second issue',
				source: { path: 'docs/ISSUE-2.md', hash: 'e'.repeat(64) },
			},
		}

		await expect(
			provider.createDefinitions?.([definition, secondDefinition]),
		).resolves.toMatchObject({
			ok: true,
			value: [{ workId: 'ISSUE-1' }, { workId: 'ISSUE-2' }],
		})

		const commands = await readFile(log, 'utf8')
		expect(commands.trim().split('\n')).toStrictEqual(['list', 'show', 'create', 'create'])
	})

	it('projects a maximum-size definition body through bounded stdin instead of argv', async () => {
		const argsLog = join(root, 'args.log')
		const stdinLog = join(root, 'stdin.log')
		const listArgsLog = join(root, 'list-args.log')
		const binary = await writeFakeBinary(`
import { readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const command = args[0]
const value = (name) => args[args.indexOf(name) + 1]
if (command === 'list') {
  writeFileSync(${JSON.stringify(listArgsLog)}, args.join('\t'))
  console.log('[]')
}
else if (command === 'show') {
  console.log(JSON.stringify({ error: 'no issues found matching the provided IDs', schema_version: 1 }))
  process.exitCode = 1
}
else if (command === 'create') {
  writeFileSync(${JSON.stringify(argsLog)}, args.join('\\t'))
  writeFileSync(${JSON.stringify(stdinLog)}, readFileSync(0))
  console.log(JSON.stringify({
    id: value('--id'),
    title: value('--title'),
    status: 'open',
    priority: 2,
    issue_type: value('--type'),
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    metadata: JSON.parse(value('--metadata')),
  }))
} else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})
		const body = `${'<>&'.repeat(1_666_666)}ab`

		await expect(
			provider.createDefinition({
				...definition,
				artifact: { ...definition.artifact, body },
			}),
		).resolves.toMatchObject({ ok: true, value: { workId: 'ISSUE-1' } })

		expect(Buffer.byteLength(body, 'utf8')).toBe(5_000_000)
		const projectedBody = await readFile(stdinLog, 'utf8')
		expect(Buffer.byteLength(JSON.stringify(projectedBody), 'utf8')).toBeLessThanOrEqual(2050)
		expect(body.startsWith(projectedBody)).toBe(true)
		const args = await readFile(argsLog, 'utf8')
		expect(args).toContain('--body-file\t-')
		expect(args).not.toContain('--description')
		expect(args).not.toContain(body.slice(0, 1000))
		const projectKey = createHash('sha256').update('example').digest('hex')
		await expect(readFile(listArgsLog, 'utf8')).resolves.toContain(
			`--metadata-field\twork_contract_project_key=${projectKey}`,
		)
	})

	it('rejects a normalized lifecycle projection that exceeds the safe item budget', async () => {
		const log = join(root, 'commands.log')
		const oversized = {
			...record('wc-1'),
			metadata: {
				...record('wc-1').metadata,
				work_contract: {
					...record('wc-1').metadata.work_contract,
					evidence: Array.from({ length: 25 }, (_, index) => ({
						kind: 'test',
						reference: `${index}-${'r'.repeat(1990)}`,
						digest: 'd'.repeat(64),
						recorded_at: '2026-09-01T00:00:00.000Z',
						actor: 'agent-a',
					})),
				},
			},
		}
		const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
const command = process.argv[2]
appendFileSync(${JSON.stringify(log)}, command + '\\n')
if (command === 'list') console.log(${JSON.stringify(JSON.stringify([oversized]))})
else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.list()

		expect(result).toMatchObject({
			ok: false,
			error: { code: 'provider_capacity_exceeded' },
		})
		await expect(readFile(log, 'utf8')).resolves.toBe('list\n')
	})

	it('rejects a create response with a non-deterministic provider ID', async () => {
		const binary = await writeFakeBinary(`
const args = process.argv.slice(2)
const command = args[0]
const value = (name) => args[args.indexOf(name) + 1]
if (command === 'list') console.log('[]')
else if (command === 'show') {
  console.log(JSON.stringify({ error: 'no issues found matching the provided IDs', schema_version: 1 }))
  process.exitCode = 1
}
else if (command === 'create') {
  console.log(JSON.stringify({
    id: 'unexpected-provider-id',
    title: value('--title'),
    status: 'open',
    priority: 2,
    issue_type: value('--type'),
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    metadata: JSON.parse(value('--metadata')),
  }))
} else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		await expect(provider.list()).resolves.toMatchObject({
			ok: true,
			value: [],
		})
		await expect(provider.createDefinition(definition)).resolves.toMatchObject({
			ok: false,
			error: { code: 'provider_mutation_failed' },
		})
	})

	it('refreshes the authoritative projection after a failed concurrent create', async () => {
		const log = join(root, 'commands.log')
		const concurrentMarker = join(root, 'concurrent-create')
		const concurrent = JSON.stringify({
			...record('wc-concurrent'),
			issue_type: 'task',
			metadata: {
				work_contract_project_key: createHash('sha256').update('example').digest('hex'),
				work_contract: {
					...record('wc-concurrent').metadata.work_contract,
					source_hash: definition.artifact.source.hash,
					graph_fingerprint: definition.graphFingerprint,
				},
			},
		})
		const binary = await writeFakeBinary(`
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
const command = process.argv[2]
appendFileSync(${JSON.stringify(log)}, command + '\\n')
if (command === 'list') {
  console.log(existsSync(${JSON.stringify(concurrentMarker)}) ? JSON.stringify([${concurrent}]) : '[]')
} else if (command === 'show') {
  console.log(JSON.stringify({ error: 'no issues found matching the provided IDs', schema_version: 1 }))
  process.exitCode = 1
} else if (command === 'create') {
  writeFileSync(${JSON.stringify(concurrentMarker)}, 'created')
  process.exit(9)
} else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		await expect(provider.list()).resolves.toMatchObject({
			ok: true,
			value: [],
		})
		await expect(provider.createDefinition(definition)).resolves.toMatchObject({
			ok: true,
			value: { workId: 'ISSUE-1' },
		})

		const commands = await readFile(log, 'utf8')
		expect(commands.trim().split('\n')).toStrictEqual(['list', 'list', 'show', 'create', 'list'])
	})

	it('rejects a concurrently created definition that does not match the requested revision', async () => {
		const concurrentMarker = join(root, 'concurrent-create')
		const staleConcurrent = JSON.stringify({
			...record('wc-concurrent'),
			issue_type: 'task',
		})
		const binary = await writeFakeBinary(`
import { existsSync, writeFileSync } from 'node:fs'
const command = process.argv[2]
if (command === 'list') {
  console.log(existsSync(${JSON.stringify(concurrentMarker)}) ? JSON.stringify([${staleConcurrent}]) : '[]')
} else if (command === 'show') {
  console.log(JSON.stringify({ error: 'no issues found matching the provided IDs', schema_version: 1 }))
  process.exitCode = 1
} else if (command === 'create') {
  writeFileSync(${JSON.stringify(concurrentMarker)}, 'created')
  process.exit(9)
} else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		await expect(provider.list()).resolves.toMatchObject({
			ok: true,
			value: [],
		})
		await expect(provider.createDefinition(definition)).resolves.toMatchObject({
			ok: false,
			error: { code: 'definition_already_exists' },
		})
	})

	it('invalidates create absence knowledge when the create response is not confirmed', async () => {
		const log = join(root, 'commands.log')
		const stale = JSON.stringify({ ...record('wc-1'), issue_type: 'task' })
		const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
const command = process.argv[2]
appendFileSync(${JSON.stringify(log)}, command + '\\n')
if (command === 'list') console.log('[]')
else if (command === 'show') {
  console.log(JSON.stringify({ error: 'no issues found matching the provided IDs', schema_version: 1 }))
  process.exitCode = 1
}
else if (command === 'create') console.log(${JSON.stringify(stale)})
else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		await expect(provider.list()).resolves.toMatchObject({
			ok: true,
			value: [],
		})
		await expect(provider.createDefinition(definition)).resolves.toMatchObject({
			ok: false,
			error: { code: 'provider_mutation_failed' },
		})
		await expect(provider.createDefinition(definition)).resolves.toMatchObject({
			ok: false,
			error: { code: 'provider_mutation_failed' },
		})

		const commands = await readFile(log, 'utf8')
		expect(commands.trim().split('\n')).toStrictEqual([
			'list',
			'list',
			'show',
			'create',
			'list',
			'show',
			'create',
		])
	})

	it('refreshes current lifecycle state after priming the create projection', async () => {
		const log = join(root, 'commands.log')
		const listCount = join(root, 'list-count')
		const open = JSON.stringify(record('wc-1'))
		const claimed = JSON.stringify({
			...record('wc-1'),
			status: 'in_progress',
			assignee: 'other',
		})
		const binary = await writeFakeBinary(`
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
const command = process.argv[2]
appendFileSync(${JSON.stringify(log)}, command + '\\n')
if (command === 'list') {
  const wasListed = existsSync(${JSON.stringify(listCount)})
  writeFileSync(${JSON.stringify(listCount)}, 'listed')
  console.log(JSON.stringify([wasListed ? ${claimed} : ${open}]))
} else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		await expect(provider.list()).resolves.toMatchObject({ ok: true })
		await expect(
			provider.claim({
				workId: 'ISSUE-1',
				actor: 'agent-a',
				timestamp: '2026-09-01T00:00:00.000Z',
				dependencyRequirements: [],
			}),
		).resolves.toMatchObject({
			ok: false,
			error: { code: 'ownership_conflict' },
		})

		const commands = await readFile(log, 'utf8')
		expect(commands.trim().split('\n')).toStrictEqual(['list', 'list'])
	})

	it('preserves the ledger-owned archived marker during definition sync', async () => {
		const log = join(root, 'commands.log')
		const archived = JSON.stringify(record('wc-1', { archived: true, status: 'closed' }))
		const archivedUpdated = JSON.stringify({
			...record('wc-1', { archived: true, status: 'closed' }),
			title: 'Updated issue',
			metadata: {
				work_contract_project_key: createHash('sha256').update('example').digest('hex'),
				work_contract: {
					...record('wc-1', { archived: true }).metadata.work_contract,
					source_hash: 'f'.repeat(64),
					graph_fingerprint: 'e'.repeat(64),
				},
			},
		})
		const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
const command = process.argv[2]
appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join('\\t') + '\\n')
if (command === 'list') console.log(JSON.stringify([${archived}]))
else if (command === 'show') console.log(${JSON.stringify(archived)})
else if (command === 'update') console.log(${JSON.stringify(archivedUpdated)})
else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const updated = await provider.updateDefinition({
			...definition,
			graphFingerprint: 'e'.repeat(64),
			artifact: {
				...definition.artifact,
				title: 'Updated issue',
				source: { ...definition.artifact.source, hash: 'f'.repeat(64) },
			},
		})
		expect(updated.ok).toBe(true)
		if (!updated.ok) {
			return
		}
		expect(updated.value.status).toBe('archived')
		const commands = await readFile(log, 'utf8')
		expect(commands).toContain('"archived":true')
	})

	it('does not report definition sync when update output omits the requested definition', async () => {
		const existing = record('wc-1')
		const binary = await writeFakeBinary(`
if (process.argv[2] === 'list') console.log(${JSON.stringify(JSON.stringify([existing]))})
else if (process.argv[2] === 'update') console.log(${JSON.stringify(JSON.stringify(existing))})
else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.updateDefinition({
			...definition,
			graphFingerprint: 'e'.repeat(64),
			artifact: { ...definition.artifact, title: 'Updated issue' },
		})

		expect(result).toMatchObject({
			ok: false,
			error: { code: 'provider_mutation_failed' },
		})
	})

	it('releases a newly acquired claim when metadata persistence fails', async () => {
		const log = join(root, 'commands.log')
		const openRecord = JSON.stringify(record('wc-1'))
		const claimedRecord = JSON.stringify({
			...record('wc-1'),
			status: 'in_progress',
			assignee: 'agent-a',
		})
		const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
const command = process.argv[2]
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(log)}, args.join('\\t') + '\\n')
if (command === 'list') console.log(JSON.stringify([${openRecord}]))
else if (command === 'show') console.log(${JSON.stringify(openRecord)})
else if (command === 'update' && args.includes('--metadata')) {
  const metadata = JSON.parse(args[args.indexOf('--metadata') + 1]).work_contract
  if (metadata.activity !== undefined) process.exit(9)
  console.log(${JSON.stringify(openRecord)})
}
else if (command === 'update') console.log(${JSON.stringify(claimedRecord)})
else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		await expect(
			provider.claim({
				workId: 'ISSUE-1',
				actor: 'agent-a',
				session: 'codex:a',
				timestamp: '2026-09-01T00:00:00.000Z',
				dependencyRequirements: [],
			}),
		).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'claim_persistence_failed' },
		})
		const commands = await readFile(log, 'utf8')
		expect(commands).toContain('--claim')
		expect(commands).toContain('--status\topen\t--assignee\t\t--actor\tagent-a')
	})

	it('restores all pre-claim state when metadata persists before a nonzero exit', async () => {
		const state = join(root, 'provider-state.json')
		const openRecord = record('wc-1')
		await writeFile(state, JSON.stringify(openRecord))
		const binary = await writeFakeBinary(`
import { readFileSync, writeFileSync } from 'node:fs'
const command = process.argv[2]
const args = process.argv.slice(2)
const current = JSON.parse(readFileSync(${JSON.stringify(state)}, 'utf8'))
if (command === 'list') console.log(JSON.stringify([current]))
else if (command === 'update' && args.includes('--claim')) {
  const claimed = { ...current, status: 'in_progress', assignee: 'agent-a' }
  writeFileSync(${JSON.stringify(state)}, JSON.stringify(claimed))
  console.log(JSON.stringify(claimed))
} else if (command === 'update' && args.includes('--metadata')) {
  const metadata = JSON.parse(args[args.indexOf('--metadata') + 1])
  const restored = {
    ...current,
    status: args.includes('--status') ? args[args.indexOf('--status') + 1] : current.status,
    assignee: args.includes('--assignee')
      ? (args[args.indexOf('--assignee') + 1] || undefined)
      : current.assignee,
    metadata,
  }
  writeFileSync(${JSON.stringify(state)}, JSON.stringify(restored))
  if (metadata.work_contract.activity !== undefined) process.exit(9)
  console.log(JSON.stringify(restored))
} else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.claim({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			session: 'codex:a',
			timestamp: '2026-09-01T00:00:00.000Z',
			dependencyRequirements: [],
		})
		expect(result).toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'claim_persistence_failed' },
		})
		await expect(
			createBeadsProvider({ root, projectId: 'example', binary }).list(),
		).resolves.toMatchObject({
			ok: true,
			value: [
				{
					workId: 'ISSUE-1',
					status: 'open',
					assignee: undefined,
					activity: undefined,
				},
			],
		})
	})

	it('reports an uncertain durable handoff intent after a nonzero comment exit', async () => {
		const log = join(root, 'commands.log')
		const durableIntent = join(root, 'durable-intent.log')
		const activeRecord = {
			...record('wc-1'),
			status: 'in_progress',
			assignee: 'agent-a',
			metadata: {
				work_contract_project_key: createHash('sha256').update('example').digest('hex'),
				work_contract: {
					...record('wc-1').metadata.work_contract,
					activity: {
						actor: 'agent-a',
						started_at: '2026-09-01T00:00:00.000Z',
						touched_at: '2026-09-01T00:00:00.000Z',
					},
				},
			},
		}
		const handoff = {
			actor: 'agent-a',
			summary: 'Continue with validation.',
			remaining: [],
			references: [],
			createdAt: '2026-09-01T01:00:00.000Z',
		}
		const active = JSON.stringify(activeRecord)
		const withHandoff = JSON.stringify({
			...activeRecord,
			metadata: {
				work_contract_project_key: createHash('sha256').update('example').digest('hex'),
				work_contract: {
					...activeRecord.metadata.work_contract,
					handoff: {
						actor: handoff.actor,
						summary: handoff.summary,
						remaining: handoff.remaining,
						references: handoff.references,
						created_at: handoff.createdAt,
					},
				},
			},
		})
		const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
const command = process.argv[2]
appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join('\\t') + '\\n')
if (command === 'list' || command === 'show') console.log(command === 'list' ? JSON.stringify([${active}]) : ${JSON.stringify(active)})
else if (command === 'update') {
  const index = process.argv.indexOf('--metadata')
  const metadata = index < 0 ? undefined : JSON.parse(process.argv[index + 1]).work_contract
  console.log(metadata?.handoff === undefined ? ${JSON.stringify(active)} : ${JSON.stringify(withHandoff)})
}
else if (command === 'comment') {
  appendFileSync(${JSON.stringify(durableIntent)}, 'persisted-before-exit\\n')
  process.exit(9)
}
else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.recordHandoff({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			release: false,
			handoff,
		})
		expect(result).toMatchObject({
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'handoff_audit_failed_recovery_required',
			},
		})
		if (!result.ok) {
			expect(result.error.details).toContain('auditCommentApplied=unknown')
			expect(result.error.details).toContain('stateMayHaveChanged=true')
		}
		await expect(readFile(durableIntent, 'utf8')).resolves.toBe('persisted-before-exit\n')
		const commands = await readFile(log, 'utf8')
		expect(commands.trim().split('\n')).toStrictEqual([
			expect.stringContaining('list\t--all\t--metadata-field\twork_contract_project_key='),
			expect.stringContaining('comment\twc-1\t--stdin'),
		])
	})

	it('does not append a handoff audit when metadata output omits the handoff', async () => {
		const log = join(root, 'commands.log')
		const active = {
			...record('wc-1'),
			status: 'in_progress' as const,
			assignee: 'agent-a',
			metadata: {
				work_contract_project_key: createHash('sha256').update('example').digest('hex'),
				work_contract: {
					...record('wc-1').metadata.work_contract,
					activity: {
						actor: 'agent-a',
						started_at: '2026-09-01T00:00:00.000Z',
						touched_at: '2026-09-01T00:00:00.000Z',
					},
				},
			},
		}
		const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(log)}, process.argv[2] + '\\n')
if (process.argv[2] === 'list') console.log(${JSON.stringify(JSON.stringify([active]))})
else if (process.argv[2] === 'update') console.log(${JSON.stringify(JSON.stringify(active))})
else if (process.argv[2] === 'comment') console.log('{}')
else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.recordHandoff({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			release: false,
			handoff: {
				actor: 'agent-a',
				summary: 'Continue with validation.',
				remaining: [],
				references: [],
				createdAt: '2026-09-01T01:00:00.000Z',
			},
		})

		expect(result).toMatchObject({
			ok: false,
			error: {
				code: 'provider_mutation_failed',
			},
		})
		if (!result.ok) {
			expect(result.error.details).toContain('operation=recordHandoff')
		}
		const commands = await readFile(log, 'utf8')
		expect(commands.trim().split('\n')).toStrictEqual(['list', 'comment', 'update'])
	})

	it('does not apply a lifecycle status when metadata output omits its requested state', async () => {
		const log = join(root, 'commands.log')
		const active = {
			...record('wc-1'),
			status: 'in_progress' as const,
			assignee: 'agent-a',
			metadata: {
				work_contract_project_key: createHash('sha256').update('example').digest('hex'),
				work_contract: {
					...record('wc-1').metadata.work_contract,
					activity: {
						actor: 'agent-a',
						started_at: '2026-09-01T00:00:00.000Z',
						touched_at: '2026-09-01T00:00:00.000Z',
					},
				},
			},
		}
		const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join('\\t') + '\\n')
if (process.argv[2] === 'list') console.log(${JSON.stringify(JSON.stringify([active]))})
else if (process.argv[2] === 'comment') console.log('{}')
else if (process.argv[2] === 'update') console.log(${JSON.stringify(JSON.stringify(active))})
else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.transition({
			type: 'block',
			workId: 'ISSUE-1',
			actor: 'agent-a',
			reason: 'waiting on approval',
		})

		expect(result).toMatchObject({
			ok: false,
			error: { code: 'provider_mutation_failed' },
		})
		const commandLog = await readFile(log, 'utf8')
		const commands = commandLog.trim().split('\n')
		expect(commands).toHaveLength(3)
		expect(commands[1]).toContain('comment\twc-1\twork-contract:block-intent:v1')
		expect(commands[2]).toContain('--metadata')
		expect(commands[2]).toContain('--status\tblocked')
	})

	it('rejects a stale expected definition before lifecycle audit or mutation', async () => {
		const log = join(root, 'commands.log')
		const active = JSON.stringify({
			...record('wc-1'),
			status: 'in_progress',
			assignee: 'agent-a',
		})
		const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(log)}, process.argv[2] + '\\n')
if (process.argv[2] === 'list') console.log(JSON.stringify([${active}]))
else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.transition({
			type: 'block',
			workId: 'ISSUE-1',
			actor: 'agent-a',
			reason: 'waiting on approval',
			expectedDefinition: { ...expectedDefinition, title: 'stale title' },
		})

		expect(result).toMatchObject({
			ok: false,
			error: { code: 'ledger_not_synchronized' },
		})
		await expect(readFile(log, 'utf8')).resolves.toBe('list\n')
	})

	it('revalidates the full parent definition closure under the mutation locks', async () => {
		const log = join(root, 'commands.log')
		const target = {
			...record('wc-1'),
			status: 'in_progress',
			assignee: 'agent-a',
			dependencies: [{ issue_id: 'wc-1', depends_on_id: 'wc-parent', type: 'parent-child' }],
		}
		const parent = {
			...record('wc-parent', { kind: 'prd' }),
			title: 'Parent changed by concurrent sync',
			metadata: {
				...record('wc-parent', { kind: 'prd' }).metadata,
				work_contract: {
					...record('wc-parent', { kind: 'prd' }).metadata.work_contract,
					work_id: 'PRD-1',
					kind: 'prd',
					source_path: 'docs/PRD-1.md',
				},
			},
		}
		const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(log)}, process.argv[2] + '\\n')
if (process.argv[2] === 'list') console.log(${JSON.stringify(JSON.stringify([target, parent]))})
else process.exit(9)
`)
		const provider = createBeadsProvider({ root, projectId: 'example', binary })
		const targetExpectation = { ...expectedDefinition, parentId: 'PRD-1' }
		const parentExpectation = {
			...expectedDefinition,
			title: 'Product',
			kind: 'prd' as const,
			source: { path: 'docs/PRD-1.md', hash: 'a'.repeat(64) },
		}

		const result = await provider.transition({
			type: 'block',
			workId: 'ISSUE-1',
			actor: 'agent-a',
			reason: 'waiting on approval',
			expectedDefinition: targetExpectation,
			expectedDefinitionClosure: [
				{ workId: 'ISSUE-1', ...targetExpectation },
				{ workId: 'PRD-1', ...parentExpectation },
			],
		})

		expect(result).toMatchObject({
			ok: false,
			error: { code: 'ledger_not_synchronized' },
		})
		await expect(readFile(log, 'utf8')).resolves.toBe('list\n')
	})

	it('rejects mismatched activity audit actors before invoking the provider', async () => {
		const secret = 'provider-secret-activity-actor'
		const log = join(root, 'commands.log')
		const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(log)}, 'invoked\\n')
process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.recordActivity({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			activity: {
				actor: secret,
				startedAt: '2026-09-01T00:00:00.000Z',
				touchedAt: '2026-09-01T01:00:00.000Z',
			},
		})

		expect(result).toMatchObject({
			ok: false,
			error: { code: 'invalid_operation_input' },
		})
		expect(JSON.stringify(result)).not.toContain(secret)
		await expect(readFile(log, 'utf8')).rejects.toThrow('ENOENT')
	})

	it('rejects mismatched handoff audit actors before invoking the provider', async () => {
		const secret = 'provider-secret-handoff-actor'
		const log = join(root, 'commands.log')
		const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(log)}, 'invoked\\n')
process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.recordHandoff({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			release: false,
			handoff: {
				actor: secret,
				summary: 'handoff',
				remaining: [],
				references: [],
				createdAt: '2026-09-01T01:00:00.000Z',
			},
		})

		expect(result).toMatchObject({
			ok: false,
			error: { code: 'invalid_operation_input' },
		})
		expect(JSON.stringify(result)).not.toContain(secret)
		await expect(readFile(log, 'utf8')).rejects.toThrow('ENOENT')
	})

	it.each([
		{
			name: 'actor',
			actor: 'provider-secret-evidence-actor',
			recordedAt: '2026-09-01T01:00:00.000Z',
		},
		{
			name: 'timestamp',
			actor: 'agent-a',
			recordedAt: '2026-09-01T02:00:00.000Z',
		},
	])(
		'rejects mismatched completion evidence $name before invoking the provider',
		async (receipt) => {
			const log = join(root, 'commands.log')
			const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(log)}, 'invoked\\n')
process.exit(9)
`)
			const provider = createBeadsProvider({
				root,
				projectId: 'example',
				binary,
			})

			const result = await provider.transition({
				type: 'complete',
				workId: 'ISSUE-1',
				actor: 'agent-a',
				evidence: [
					{
						kind: 'test',
						reference: 'test-output',
						digest: 'd'.repeat(64),
						recordedAt: receipt.recordedAt,
						actor: receipt.actor,
					},
				],
				timestamp: '2026-09-01T01:00:00.000Z',
			})

			expect(result).toMatchObject({
				ok: false,
				error: { code: 'invalid_operation_input' },
			})
			expect(JSON.stringify(result)).not.toContain(receipt.actor)
			await expect(readFile(log, 'utf8')).rejects.toThrow('ENOENT')
		},
	)

	it.each([
		{
			name: 'start time',
			activity: {
				actor: 'agent-a',
				role: 'implementer',
				session: 'session-a',
				startedAt: '2026-09-01T00:30:00.000Z',
				touchedAt: '2026-09-01T01:00:00.000Z',
			},
		},
		{
			name: 'role',
			activity: {
				actor: 'agent-a',
				role: 'reviewer',
				session: 'session-a',
				startedAt: '2026-09-01T00:00:00.000Z',
				touchedAt: '2026-09-01T01:00:00.000Z',
			},
		},
		{
			name: 'session without replacement mode',
			activity: {
				actor: 'agent-a',
				role: 'implementer',
				session: 'session-b',
				startedAt: '2026-09-01T00:00:00.000Z',
				touchedAt: '2026-09-01T01:00:00.000Z',
			},
		},
	])('rejects an activity update that changes the persisted $name', async ({ activity }) => {
		const log = join(root, 'commands.log')
		const active = {
			...record('wc-1'),
			status: 'in_progress',
			assignee: 'agent-a',
			metadata: {
				work_contract_project_key: createHash('sha256').update('example').digest('hex'),
				work_contract: {
					...record('wc-1').metadata.work_contract,
					activity: {
						actor: 'agent-a',
						role: 'implementer',
						session: 'session-a',
						started_at: '2026-09-01T00:00:00.000Z',
						touched_at: '2026-09-01T00:00:00.000Z',
					},
				},
			},
		}
		const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(log)}, process.argv[2] + '\\n')
if (process.argv[2] === 'list') console.log(${JSON.stringify(JSON.stringify([active]))})
else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.recordActivity({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			activity,
		})

		expect(result).toMatchObject({
			ok: false,
			error: { code: 'invalid_operation_input' },
		})
		await expect(readFile(log, 'utf8')).resolves.toBe('list\n')
	})

	it('allows an explicit activity session replacement while preserving actor, role, and start time', async () => {
		const log = join(root, 'commands.log')
		const activity = {
			actor: 'agent-a',
			role: 'implementer',
			session: 'session-b',
			started_at: '2026-09-01T00:00:00.000Z',
			touched_at: '2026-09-01T01:00:00.000Z',
		}
		const active = {
			...record('wc-1'),
			status: 'in_progress',
			assignee: 'agent-a',
			metadata: {
				work_contract_project_key: createHash('sha256').update('example').digest('hex'),
				work_contract: {
					...record('wc-1').metadata.work_contract,
					activity: {
						...activity,
						session: 'session-a',
						touched_at: activity.started_at,
					},
				},
			},
		}
		const updated = {
			...active,
			metadata: {
				work_contract: { ...active.metadata.work_contract, activity },
			},
		}
		const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(log)}, process.argv[2] + '\\n')
if (process.argv[2] === 'list') console.log(${JSON.stringify(JSON.stringify([active]))})
else if (process.argv[2] === 'update') console.log(${JSON.stringify(JSON.stringify(updated))})
else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.recordActivity({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			replaceSession: true,
			activity: {
				actor: activity.actor,
				role: activity.role,
				session: activity.session,
				startedAt: activity.started_at,
				touchedAt: activity.touched_at,
			},
		})

		expect(result).toMatchObject({
			ok: true,
			value: { activity: { session: 'session-b' } },
		})
		await expect(readFile(log, 'utf8')).resolves.toBe('list\nupdate\n')
	})

	it('rejects a handoff from-session that differs from current activity', async () => {
		const secret = 'provider-secret-current-session'
		const log = join(root, 'commands.log')
		const active = {
			...record('wc-1'),
			status: 'in_progress',
			assignee: 'agent-a',
			metadata: {
				work_contract_project_key: createHash('sha256').update('example').digest('hex'),
				work_contract: {
					...record('wc-1').metadata.work_contract,
					activity: {
						actor: 'agent-a',
						session: secret,
						started_at: '2026-09-01T00:00:00.000Z',
						touched_at: '2026-09-01T00:00:00.000Z',
					},
				},
			},
		}
		const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(log)}, process.argv[2] + '\\n')
if (process.argv[2] === 'list') console.log(${JSON.stringify(JSON.stringify([active]))})
else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.recordHandoff({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			release: false,
			handoff: {
				actor: 'agent-a',
				fromSession: 'session-b',
				summary: 'handoff',
				remaining: [],
				references: [],
				createdAt: '2026-09-01T01:00:00.000Z',
			},
		})

		expect(result).toMatchObject({
			ok: false,
			error: { code: 'session_conflict' },
		})
		expect(JSON.stringify(result)).not.toContain(secret)
		await expect(readFile(log, 'utf8')).resolves.toBe('list\n')
	})

	it('does not close an archive when update output omits the archived marker', async () => {
		const log = join(root, 'commands.log')
		const openRecord = record('wc-1')
		const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(log)}, process.argv[2] + '\\n')
if (process.argv[2] === 'list') console.log(${JSON.stringify(JSON.stringify([openRecord]))})
else if (process.argv[2] === 'update') console.log(${JSON.stringify(JSON.stringify(openRecord))})
else if (process.argv[2] === 'close') console.log(${JSON.stringify(JSON.stringify({ ...openRecord, status: 'closed' }))})
else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.archive('ISSUE-1')

		expect(result).toMatchObject({
			ok: false,
			error: { code: 'provider_mutation_failed' },
		})
		const commands = await readFile(log, 'utf8')
		expect(commands.trim().split('\n')).toStrictEqual(['list', 'update'])
	})

	it('does not close an archive when its marker response contains multiple records', async () => {
		const log = join(root, 'commands.log')
		const openRecord = record('wc-1')
		const archivedRecord = {
			...openRecord,
			metadata: {
				...openRecord.metadata,
				work_contract: { ...openRecord.metadata.work_contract, archived: true },
			},
		}
		const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(log)}, process.argv[2] + '\\n')
if (process.argv[2] === 'list') console.log(${JSON.stringify(JSON.stringify([openRecord]))})
else if (process.argv[2] === 'update') console.log(${JSON.stringify(JSON.stringify([archivedRecord, archivedRecord]))})
else if (process.argv[2] === 'close') console.log(${JSON.stringify(JSON.stringify({ ...archivedRecord, status: 'closed' }))})
else process.exit(9)
`)
		const provider = createBeadsProvider({ root, projectId: 'example', binary })

		const result = await provider.archive('ISSUE-1')

		expect(result).toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'provider_mutation_failed' },
		})
		await expect(readFile(log, 'utf8')).resolves.toBe('list\nupdate\n')
	})

	it('accepts the bounded relation acknowledgement that omits relation data before final reconciliation', async () => {
		const marker = join(root, 'reparented')
		const child = record('wc-1')
		const parent = {
			...record('wc-2'),
			title: 'Parent',
			metadata: {
				work_contract_project_key: createHash('sha256').update('example').digest('hex'),
				work_contract: {
					...record('wc-2').metadata.work_contract,
					work_id: 'ISSUE-2',
					source_path: 'docs/ISSUE-2.md',
				},
			},
		}
		const reconciledChild = {
			...child,
			dependencies: [
				{
					dependency_type: 'parent-child',
					metadata: parent.metadata,
				},
			],
		}
		const binary = await writeFakeBinary(`
import { existsSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (args[0] === 'list') {
  console.log(JSON.stringify([existsSync(${JSON.stringify(marker)}) ? ${JSON.stringify(reconciledChild)} : ${JSON.stringify(child)}, ${JSON.stringify(parent)}]))
} else if (args[0] === 'update' && args.includes('--parent')) {
  writeFileSync(${JSON.stringify(marker)}, 'updated')
  console.log(JSON.stringify([${JSON.stringify(child)}]))
} else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.setRelations({
			workId: 'ISSUE-1',
			parentId: 'ISSUE-2',
			dependencies: [],
		})

		expect(result).toMatchObject({ ok: true, value: { parentId: 'ISSUE-2' } })
	})

	it('reports partial relation reconciliation after an earlier mutation lands', async () => {
		const log = join(root, 'commands.log')
		const child = JSON.stringify(record('wc-1'))
		const parent = JSON.stringify({
			...record('wc-2'),
			title: 'Parent',
			metadata: {
				work_contract_project_key: createHash('sha256').update('example').digest('hex'),
				work_contract: {
					...record('wc-2').metadata.work_contract,
					work_id: 'ISSUE-2',
					source_path: 'docs/ISSUE-2.md',
				},
			},
		})
		const reparented = JSON.stringify({
			...record('wc-1'),
			dependencies: [
				{
					dependency_type: 'parent-child',
					metadata: {
						work_contract_project_key: createHash('sha256').update('example').digest('hex'),
						work_contract: {
							...record('wc-2').metadata.work_contract,
							work_id: 'ISSUE-2',
							source_path: 'docs/ISSUE-2.md',
						},
					},
				},
			],
		})
		const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
const command = process.argv[2]
appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join('\\t') + '\\n')
if (command === 'list') console.log(JSON.stringify([${child}, ${parent}]))
else if (command === 'show') console.log(process.argv[3] === 'wc-1' ? ${JSON.stringify(child)} : ${JSON.stringify(parent)})
else if (command === 'update') console.log(${JSON.stringify(reparented)})
else if (command === 'dep') process.exit(9)
else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const result = await provider.setRelations({
			workId: 'ISSUE-1',
			parentId: 'ISSUE-2',
			dependencies: ['ISSUE-2'],
		})
		expect(result.ok).toBe(false)
		if (result.ok) {
			return
		}
		expect(result.error).toMatchObject({
			type: 'work_contract_error',
			code: 'relation_reconciliation_failed',
		})
		expect(result.error.details).toContain('mutationsApplied=1')
		expect(result.error.details).toContain('stateMayHaveChanged=true')
	})

	it.each(['open', 'closed'] as const)(
		'rejects activity updates from %s at the adapter boundary',
		async (status) => {
			const log = join(root, 'commands.log')
			const item = JSON.stringify({
				...record('wc-1', { status }),
				...(status === 'closed' ? { assignee: 'agent-a' } : {}),
				metadata: {
					work_contract_project_key: createHash('sha256').update('example').digest('hex'),
					work_contract: {
						...record('wc-1').metadata.work_contract,
						...(status === 'closed'
							? {
									activity: {
										actor: 'agent-a',
										started_at: '2026-09-01T00:00:00.000Z',
										touched_at: '2026-09-01T00:00:00.000Z',
									},
								}
							: {}),
					},
				},
			})
			const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(log)}, process.argv[2] + '\\n')
if (process.argv[2] === 'list') console.log(JSON.stringify([${item}]))
else process.exit(9)
`)
			const provider = createBeadsProvider({
				root,
				projectId: 'example',
				binary,
			})

			await expect(
				provider.recordActivity({
					workId: 'ISSUE-1',
					actor: 'agent-a',
					activity: {
						actor: 'agent-a',
						startedAt: '2026-09-01T00:00:00.000Z',
						touchedAt: '2026-09-01T01:00:00.000Z',
					},
				}),
			).resolves.toMatchObject({
				ok: false,
				error: { code: 'invalid_transition' },
			})
			const commands = await readFile(log, 'utf8')
			expect(commands.trim().split('\n')).toStrictEqual(['list'])
		},
	)

	it.each(['open', 'closed'] as const)(
		'rejects handoff from %s at the adapter boundary',
		async (status) => {
			const log = join(root, 'commands.log')
			const item = JSON.stringify({
				...record('wc-1', { status }),
				...(status === 'closed' ? { assignee: 'agent-a' } : {}),
				metadata: {
					work_contract_project_key: createHash('sha256').update('example').digest('hex'),
					work_contract: {
						...record('wc-1').metadata.work_contract,
						...(status === 'closed'
							? {
									activity: {
										actor: 'agent-a',
										started_at: '2026-09-01T00:00:00.000Z',
										touched_at: '2026-09-01T00:00:00.000Z',
									},
								}
							: {}),
					},
				},
			})
			const binary = await writeFakeBinary(`
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(log)}, process.argv[2] + '\\n')
if (process.argv[2] === 'list') console.log(JSON.stringify([${item}]))
else process.exit(9)
`)
			const provider = createBeadsProvider({
				root,
				projectId: 'example',
				binary,
			})

			await expect(
				provider.recordHandoff({
					workId: 'ISSUE-1',
					actor: 'agent-a',
					release: false,
					handoff: {
						actor: 'agent-a',
						summary: 'handoff',
						remaining: [],
						references: [],
						createdAt: '2026-09-01T01:00:00.000Z',
					},
				}),
			).resolves.toMatchObject({
				ok: false,
				error: { code: 'invalid_transition' },
			})
			const commands = await readFile(log, 'utf8')
			expect(commands.trim().split('\n')).toStrictEqual(['list'])
		},
	)

	it('enforces the lifecycle matrix when the adapter is called directly', async () => {
		const closed = JSON.stringify({
			...record('wc-1', { status: 'closed' }),
			assignee: 'agent-a',
		})
		const binary = await writeFakeBinary(`
const command = process.argv[2]
if (command === 'list') console.log(JSON.stringify([${closed}]))
else if (command === 'show') console.log(${JSON.stringify(closed)})
else process.exit(9)
`)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		await expect(
			provider.transition({
				type: 'release',
				workId: 'ISSUE-1',
				actor: 'agent-a',
				reason: 'bypass reopen',
			}),
		).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_transition' },
		})
	})
})
