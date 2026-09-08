/**
 * @description Verifies manifest and Markdown compilation, graph validation, and path containment.
 *
 * @module work/compiler
 * @file Compiler.test.ts
 */

/* oxlint-disable vitest/prefer-expect-assertions -- Compiler tests assert after Result narrowing. */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { compileWorkGraph, loadWorkManifest } from './compiler'
import { WORK_DEFINITION_LIMITS } from './contracts'
import { INPUT_LIMITS } from './files'

const roots: string[] = []

const createProject = async (): Promise<string> => {
	const root = await mkdtemp(join(tmpdir(), 'work-contract-compiler-'))
	roots.push(root)
	await mkdir(join(root, 'docs', 'initiatives'), { recursive: true })
	await mkdir(join(root, 'docs', 'prds'), { recursive: true })
	await mkdir(join(root, 'docs', 'issues'), { recursive: true })
	await writeFile(
		join(root, 'work.yaml'),
		`version: 1
project:
  id: example
sources:
  - kind: initiative
    include: docs/initiatives/*.md
  - kind: prd
    include: docs/prds/*.md
    parentFields: [initiative]
  - kind: issue
    include: docs/issues/*.md
    parentFields: [prd, parent]
policies:
  contextMaxBytes: 12000
  staleClaimMinutes: 90
  terminalEvidence: [test]
`,
	)
	return root
}

afterEach(async () => {
	const { rm } = await import('node:fs/promises')
	await Promise.all(roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })))
})

describe('work definition compiler', () => {
	it('loads a repository-owned project UID from the manifest', async () => {
		const root = await createProject()
		await writeFile(
			join(root, 'work.yaml'),
			`version: 1
project:
  id: example
  uid: 123e4567-e89b-42d3-a456-426614174000
sources: []
`,
		)

		await expect(loadWorkManifest({ root })).resolves.toMatchObject({
			ok: true,
			value: {
				projectId: 'example',
				projectUid: '123e4567-e89b-42d3-a456-426614174000',
			},
		})
	})

	it('rejects a malformed project UID', async () => {
		const root = await createProject()
		await writeFile(
			join(root, 'work.yaml'),
			`version: 1
project:
  id: example
  uid: ../../private
sources: []
`,
		)

		await expect(loadWorkManifest({ root })).resolves.toMatchObject({
			ok: false,
			error: { code: 'invalid_work_manifest' },
		})
	})

	it('defaults execution to task and compiles explicit aggregate execution', async () => {
		const root = await createProject()
		await writeFile(
			join(root, 'docs', 'issues', 'ISSUE-1-task.md'),
			'---\nid: ISSUE-1\ntitle: Task\n---\n\n# ISSUE-1 Task\n',
		)
		await writeFile(
			join(root, 'docs', 'issues', 'ISSUE-2-aggregate.md'),
			'---\nid: ISSUE-2\ntitle: Aggregate\nexecution: aggregate\n---\n\n# ISSUE-2 Aggregate\n',
		)

		const manifest = await loadWorkManifest({ root })
		expect(manifest.ok).toBe(true)
		if (!manifest.ok) {
			return
		}
		const compiled = await compileWorkGraph({ root, manifest: manifest.value })

		expect(compiled.ok).toBe(true)
		if (!compiled.ok) {
			return
		}
		expect(compiled.value.items.map(({ id, execution }) => ({ id, execution }))).toStrictEqual([
			{ id: 'ISSUE-1', execution: 'task' },
			{ id: 'ISSUE-2', execution: 'aggregate' },
		])
	})

	it('rejects unsupported aggregate execution values', async () => {
		const root = await createProject()
		await writeFile(
			join(root, 'docs', 'issues', 'ISSUE-1-invalid.md'),
			'---\nid: ISSUE-1\ntitle: Invalid\nexecution: background\n---\n\n# ISSUE-1 Invalid\n',
		)
		const manifest = await loadWorkManifest({ root })
		expect(manifest.ok).toBe(true)
		if (!manifest.ok) {
			return
		}

		await expect(compileWorkGraph({ root, manifest: manifest.value })).resolves.toMatchObject({
			ok: false,
			error: { code: 'invalid_work_artifact' },
		})
	})

	it('bounds aggregate direct children to the atomic provider lock budget', async () => {
		const root = await createProject()
		await writeFile(
			join(root, 'docs', 'issues', 'ISSUE-1-aggregate.md'),
			'---\nid: ISSUE-1\ntitle: Aggregate\nexecution: aggregate\n---\n\n# ISSUE-1 Aggregate\n',
		)
		await Promise.all(
			Array.from({ length: WORK_DEFINITION_LIMITS.dependencies + 1 }, async (_, index) =>
				writeFile(
					join(root, 'docs', 'issues', `ISSUE-${index + 2}-child.md`),
					`---\nid: ISSUE-${index + 2}\ntitle: Child ${index + 1}\nparent: ISSUE-1\n---\n\n# ISSUE-${index + 2} Child\n`,
				),
			),
		)
		const manifest = await loadWorkManifest({ root })
		expect(manifest.ok).toBe(true)
		if (!manifest.ok) {
			return
		}

		await expect(compileWorkGraph({ root, manifest: manifest.value })).resolves.toMatchObject({
			ok: false,
			error: { code: 'invalid_work_graph' },
		})
	})

	it('defaults existing manifests to the evidence-only delivery contract', async () => {
		const root = await createProject()
		const manifest = await loadWorkManifest({ root })

		expect(manifest).toMatchObject({
			ok: true,
			value: {
				policies: {
					delivery: {
						profile: 'evidence-only',
						isolation: 'none',
						integration: 'evidence',
						terminal: 'evidence',
						requiredGates: [],
					},
				},
			},
		})
	})

	it('expands and validates a configurable local delivery policy', async () => {
		const root = await createProject()
		await writeFile(
			join(root, 'work.yaml'),
			`version: 1
project:
  id: example
sources:
  - kind: issue
    include: docs/issues/*.md
policies:
  delivery:
    profile: local-direct
    isolation: worktree
    targetRef: refs/heads/main
    requiredGates: [validation, landing]
`,
		)

		await expect(loadWorkManifest({ root })).resolves.toMatchObject({
			ok: true,
			value: {
				policies: {
					delivery: {
						profile: 'local-direct',
						isolation: 'worktree',
						integration: 'local',
						terminal: 'landed',
						targetRef: 'refs/heads/main',
						requiredGates: ['validation', 'landing'],
					},
				},
			},
		})

		await writeFile(
			join(root, 'work.yaml'),
			`version: 1
project: { id: example }
sources:
  - kind: issue
    include: docs/issues/*.md
policies:
  delivery:
    profile: local-direct
    integration: local
    terminal: merged
`,
		)
		await expect(loadWorkManifest({ root })).resolves.toMatchObject({
			ok: false,
			error: { code: 'invalid_work_manifest' },
		})
	})

	it('compiles linked initiative, PRD, and issue files into a deterministic graph', async () => {
		const root = await createProject()
		await writeFile(
			join(root, 'docs', 'initiatives', 'INIT-1-example.md'),
			'# INIT-1: Example initiative\n\n## Outcome\n\nShip the example.\n',
		)
		await writeFile(
			join(root, 'docs', 'prds', 'PRD-1-example.md'),
			'# PRD-1: Example product\n\n**Initiative:** INIT-1\n\n## Acceptance Criteria\n\n- Operators can inspect work.\n',
		)
		await writeFile(
			join(root, 'docs', 'issues', 'ISSUE-1-build.md'),
			`---
id: ISSUE-1
title: Build the example
prd: PRD-1
depends_on: ""
roles: [implementer]
evidence: [test]
---

# ISSUE-1 Build the example

## Acceptance Criteria

- The package returns a graph.
`,
		)

		const manifest = await loadWorkManifest({ root })
		expect(manifest.ok).toBe(true)
		if (!manifest.ok) {
			return
		}

		const first = await compileWorkGraph({ root, manifest: manifest.value })
		const second = await compileWorkGraph({ root, manifest: manifest.value })

		expect(first.ok).toBe(true)
		if (!first.ok || !second.ok) {
			return
		}
		expect(first.value.fingerprint).toBe(second.value.fingerprint)
		expect(
			first.value.items.map(({ id, kind, parentId }) => ({ id, kind, parentId })),
		).toStrictEqual([
			{ id: 'INIT-1', kind: 'initiative', parentId: undefined },
			{ id: 'ISSUE-1', kind: 'issue', parentId: 'PRD-1' },
			{ id: 'PRD-1', kind: 'prd', parentId: 'INIT-1' },
		])
		expect(first.value.items.find(({ id }) => id === 'ISSUE-1')?.acceptance).toStrictEqual([
			'The package returns a graph.',
		])
	})

	it('accepts canonical non-numeric work IDs from frontmatter, headings, and filenames', async () => {
		const root = await createProject()
		await writeFile(
			join(root, 'docs', 'issues', 'frontmatter.md'),
			'---\nid: ISSUE-OLD\ntitle: Frontmatter identity\n---\nBody.\n',
		)
		await writeFile(
			join(root, 'docs', 'issues', 'heading.md'),
			'# ISSUE-HEADING: Heading identity\n',
		)
		await writeFile(
			join(root, 'docs', 'issues', 'ISSUE-FILENAME-work.md'),
			'---\ntitle: Filename identity\n---\nBody.\n',
		)
		await writeFile(
			join(root, 'docs', 'issues', 'lower-heading.md'),
			'# issue-lower-heading: Lower heading identity\n',
		)
		await writeFile(
			join(root, 'docs', 'issues', 'issue-lowerfile.md'),
			'---\ntitle: Lower filename identity\n---\nBody.\n',
		)

		const manifest = await loadWorkManifest({ root })
		if (!manifest.ok) {
			throw new Error(manifest.error.message)
		}
		const result = await compileWorkGraph({ root, manifest: manifest.value })

		expect(result.ok).toBe(true)
		if (!result.ok) {
			return
		}
		expect(result.value.items.map(({ id }) => id)).toStrictEqual([
			'ISSUE-FILENAME',
			'ISSUE-HEADING',
			'ISSUE-LOWER-HEADING',
			'ISSUE-LOWERFILE',
			'ISSUE-OLD',
		])
	})

	it('rejects a work ID whose canonical suffix exceeds its segment bound', async () => {
		const root = await createProject()
		await writeFile(
			join(root, 'docs', 'issues', 'invalid.md'),
			`---\nid: ISSUE-${'A'.repeat(65)}\ntitle: Invalid identity\n---\nBody.\n`,
		)
		const manifest = await loadWorkManifest({ root })
		if (!manifest.ok) {
			throw new Error(manifest.error.message)
		}

		await expect(compileWorkGraph({ root, manifest: manifest.value })).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_work_artifact' },
		})
	})

	it('rejects missing parents and dependency cycles before provider mutation', async () => {
		const root = await createProject()
		await writeFile(
			join(root, 'docs', 'issues', 'ISSUE-1-one.md'),
			'---\nid: ISSUE-1\ntitle: One\nprd: PRD-999\ndepends_on: ISSUE-2\n---\n# ISSUE-1 One\n',
		)
		await writeFile(
			join(root, 'docs', 'issues', 'ISSUE-2-two.md'),
			'---\nid: ISSUE-2\ntitle: Two\ndepends_on: ISSUE-1\n---\n# ISSUE-2 Two\n',
		)

		const manifest = await loadWorkManifest({ root })
		if (!manifest.ok) {
			throw new Error('fixture manifest failed')
		}
		const result = await compileWorkGraph({ root, manifest: manifest.value })

		expect(result).toStrictEqual({
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_work_graph',
				message: 'Work graph validation failed.',
				details: [
					'ISSUE-1 references missing parent PRD-999.',
					'Dependency cycle detected: ISSUE-1 -> ISSUE-2 -> ISSUE-1.',
				],
			},
		})
	})

	it('rejects parent cycles before hierarchical projection or rollup', async () => {
		const root = await createProject()
		await writeFile(
			join(root, 'docs', 'issues', 'ISSUE-1-one.md'),
			'---\nid: ISSUE-1\nparent: ISSUE-2\n---\n# ISSUE-1 One\n',
		)
		await writeFile(
			join(root, 'docs', 'issues', 'ISSUE-2-two.md'),
			'---\nid: ISSUE-2\nparent: ISSUE-1\n---\n# ISSUE-2 Two\n',
		)
		const manifest = await loadWorkManifest({ root })
		if (!manifest.ok) {
			throw new Error('fixture manifest failed')
		}

		await expect(compileWorkGraph({ root, manifest: manifest.value })).resolves.toMatchObject({
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_work_graph',
				details: ['Parent cycle detected: ISSUE-1 -> ISSUE-2 -> ISSUE-1.'],
			},
		})
	})

	it('rejects source files whose resolved path escapes the repository', async () => {
		const root = await createProject()
		const outside = await mkdtemp(join(tmpdir(), 'work-contract-outside-'))
		roots.push(outside)
		await writeFile(join(outside, 'ISSUE-9.md'), '# ISSUE-9 Escaped\n')
		const { symlink } = await import('node:fs/promises')
		await symlink(join(outside, 'ISSUE-9.md'), join(root, 'docs', 'issues', 'ISSUE-9.md'))

		const manifest = await loadWorkManifest({ root })
		if (!manifest.ok) {
			throw new Error('fixture manifest failed')
		}
		const result = await compileWorkGraph({ root, manifest: manifest.value })

		expect(result.ok).toBe(false)
		if (result.ok) {
			return
		}
		expect(result.error.code).toBe('unsafe_source_path')
	})

	it('rejects manifest paths and symlinks outside the repository boundary', async () => {
		const root = await createProject()
		const outside = await mkdtemp(join(tmpdir(), 'work-contract-manifest-outside-'))
		roots.push(outside)
		await writeFile(
			join(outside, 'outside.yaml'),
			'version: 1\nproject: { id: escaped }\nsources: []\n',
		)
		const { symlink } = await import('node:fs/promises')
		await symlink(join(outside, 'outside.yaml'), join(root, 'linked.yaml'))

		await expect(loadWorkManifest({ root, path: '../outside.yaml' })).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'unsafe_work_manifest' },
		})
		await expect(loadWorkManifest({ root, path: 'linked.yaml' })).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'unsafe_work_manifest' },
		})
	})

	it.each([
		String.raw`..\outside\*.md`,
		String.raw`C:\outside\*.md`,
		String.raw`\\server\share\*.md`,
	])('rejects Windows-dialect source traversal %s on every host', async (include) => {
		const root = await createProject()
		await writeFile(
			join(root, 'work.yaml'),
			JSON.stringify({
				version: 1,
				project: { id: 'example' },
				sources: [{ kind: 'issue', include }],
			}),
		)

		await expect(loadWorkManifest({ root })).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_work_manifest' },
		})
	})

	it('rejects policy typos and malformed role metadata instead of weakening gates', async () => {
		const root = await createProject()
		await writeFile(
			join(root, 'work.yaml'),
			'version: 1\nproject: { id: example }\nsources: [{ kind: issue, include: docs/issues/*.md }]\npolicies: { contextMaxBytes: nope, terminalEvidence: [tset] }\n',
		)
		await expect(loadWorkManifest({ root })).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_work_manifest' },
		})
		await writeFile(
			join(root, 'work.yaml'),
			'version: 1\nproject: { id: example }\nsources: [{ kind: issue, include: docs/issues/*.md }]\npolicies: { terminalEvidnce: [test] }\n',
		)
		await expect(loadWorkManifest({ root })).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_work_manifest' },
		})

		await writeFile(
			join(root, 'work.yaml'),
			'version: 1\nproject: { id: example }\nsources: [{ kind: issue, include: docs/issues/*.md }]\n',
		)
		await writeFile(
			join(root, 'docs', 'issues', 'ISSUE-8.md'),
			'---\nid: ISSUE-8\nroles: [coder, 7]\nevidence: [tset]\n---\n# ISSUE-8 Invalid policy\n',
		)
		const manifest = await loadWorkManifest({ root })
		if (!manifest.ok) {
			throw new Error('fixture manifest failed')
		}
		await expect(compileWorkGraph({ root, manifest: manifest.value })).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_work_artifact' },
		})
	})

	it.each([
		{
			label: 'a multibyte title beyond the provider byte bound',
			source: `---\nid: ISSUE-1\ntitle: ${'界'.repeat(167)}\n---\n# ISSUE-1 Work\n`,
		},
		{
			label: 'more than 100 roles',
			source: `---\nid: ISSUE-1\nroles: [${Array.from({ length: 101 }, (_, index) => `role-${index}`).join(', ')}]\n---\n# ISSUE-1 Work\n`,
		},
		{
			label: 'more than 100 owners',
			source: `---\nid: ISSUE-1\nowners: [${Array.from({ length: 101 }, (_, index) => `owner-${index}`).join(', ')}]\n---\n# ISSUE-1 Work\n`,
		},
		{
			label: 'more than 1000 dependencies',
			source: `---\nid: ISSUE-1\ndependencies: [${Array.from({ length: 1001 }, (_, index) => `ISSUE-${index + 2}`).join(', ')}]\n---\n# ISSUE-1 Work\n`,
		},
		{
			label: 'more than 1000 acceptance entries',
			source: `# ISSUE-1 Work\n\n## Acceptance Criteria\n\n${Array.from({ length: 1001 }, (_, index) => `- condition ${index}`).join('\n')}\n`,
		},
	])('rejects $label before provider synchronization', async ({ source }) => {
		const root = await createProject()
		await writeFile(join(root, 'docs', 'issues', 'ISSUE-1-work.md'), source)
		const manifest = await loadWorkManifest({ root })
		if (!manifest.ok) {
			throw new Error(manifest.error.message)
		}

		await expect(compileWorkGraph({ root, manifest: manifest.value })).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_work_artifact' },
		})
	})

	it('bounds manifest project IDs, source configurations, patterns, and field aliases', async () => {
		const root = await createProject()
		const manifests = [
			`version: 1\nproject: { id: ${'界'.repeat(43)} }\nsources: []\n`,
			`version: 1\nproject: { id: example }\nsources:\n${Array.from({ length: 1001 }, () => '  - { kind: issue, include: docs/issues/*.md }').join('\n')}\n`,
			`version: 1\nproject: { id: example }\nsources:\n  - kind: issue\n    include: [${Array.from({ length: 1001 }, (_, index) => `docs/issues/${index}.md`).join(', ')}]\n`,
			`version: 1\nproject: { id: example }\nsources:\n  - kind: issue\n    include: docs/issues/*.md\n    parentFields: [${Array.from({ length: 101 }, (_, index) => `parent${index}`).join(', ')}]\n`,
		]

		for (const source of manifests) {
			await writeFile(join(root, 'work.yaml'), source)
			await expect(loadWorkManifest({ root })).resolves.toMatchObject({
				ok: false,
				error: { type: 'work_contract_error', code: 'invalid_work_manifest' },
			})
		}
	})

	it('rejects acceptance whose aggregate bytes exceed the provider transport budget', async () => {
		const root = await createProject()
		const acceptance = Array.from(
			{ length: 10 },
			(_, index) => `- ${String(index).padStart(2, '0')}${'a'.repeat(1995)}`,
		).join('\n')
		await writeFile(
			join(root, 'docs', 'issues', 'ISSUE-1.md'),
			`# ISSUE-1 Work\n\n## Acceptance Criteria\n\n${acceptance}\n`,
		)
		const manifest = await loadWorkManifest({ root })
		if (!manifest.ok) {
			throw new Error(manifest.error.message)
		}

		await expect(compileWorkGraph({ root, manifest: manifest.value })).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_work_artifact' },
		})
	})

	it('rejects a source corpus that exceeds the cumulative retained-byte budget', async () => {
		const root = await createProject()
		const body = 'x'.repeat(4_000_000)
		await Promise.all(
			Array.from({ length: 4 }, async (_, index) =>
				writeFile(
					join(root, 'docs', 'issues', `ISSUE-${index}.md`),
					`# ISSUE-${index} Work ${index}\n${body}`,
				),
			),
		)
		const manifest = await loadWorkManifest({ root })
		if (!manifest.ok) {
			throw new Error(manifest.error.message)
		}

		await expect(compileWorkGraph({ root, manifest: manifest.value })).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'source_too_large' },
		})
	})

	it('enforces byte ceilings before parsing manifests and work sources', async () => {
		const root = await createProject()
		await writeFile(join(root, 'work.yaml'), 'x'.repeat(INPUT_LIMITS.manifestBytes + 1))
		await expect(loadWorkManifest({ root })).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'work_manifest_too_large' },
		})

		await writeFile(
			join(root, 'work.yaml'),
			'version: 1\nproject: { id: example }\nsources: [{ kind: issue, include: docs/issues/*.md }]\n',
		)
		await writeFile(
			join(root, 'docs', 'issues', 'ISSUE-1.md'),
			`# ISSUE-1 Large\n${'x'.repeat(INPUT_LIMITS.sourceBytes + 1)}`,
		)
		const manifest = await loadWorkManifest({ root })
		if (!manifest.ok) {
			throw new Error(manifest.error.message)
		}
		await expect(compileWorkGraph({ root, manifest: manifest.value })).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'source_too_large' },
		})
	})

	it('rejects malformed UTF-8 before parsing manifests and work sources', async () => {
		const root = await createProject()
		await writeFile(join(root, 'work.yaml'), Uint8Array.from([0xc3, 0x28]))
		const invalidManifest = await loadWorkManifest({ root })
		expect(invalidManifest).toMatchObject({
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_work_manifest',
			},
		})
		if (invalidManifest.ok) {
			return
		}
		expect(invalidManifest.error.message).toMatch(/utf-?8/i)

		await writeFile(
			join(root, 'work.yaml'),
			'version: 1\nproject: { id: example }\nsources: [{ kind: issue, include: docs/issues/*.md }]\n',
		)
		await writeFile(join(root, 'docs', 'issues', 'ISSUE-1.md'), Uint8Array.from([0xc3, 0x28]))
		const manifest = await loadWorkManifest({ root })
		if (!manifest.ok) {
			throw new Error(manifest.error.message)
		}
		const invalidSource = await compileWorkGraph({ root, manifest: manifest.value })
		expect(invalidSource).toMatchObject({
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'source_read_failed',
			},
		})
		if (invalidSource.ok) {
			return
		}
		expect(invalidSource.error.message).toMatch(/utf-?8/i)
	})

	it('does not expose malformed YAML content through compiler diagnostics', async () => {
		const root = await createProject()
		const privateCanary = 'PRIVATE_YAML_CANARY_/Users/operator/secret.md'
		await writeFile(join(root, 'work.yaml'), `version: [${privateCanary}\n`)

		const invalidManifest = await loadWorkManifest({ root })

		expect(invalidManifest).toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_work_manifest' },
		})
		expect(JSON.stringify(invalidManifest)).not.toContain(privateCanary)

		await writeFile(
			join(root, 'work.yaml'),
			'version: 1\nproject: { id: example }\nsources: [{ kind: issue, include: docs/issues/*.md }]\n',
		)
		await writeFile(
			join(root, 'docs', 'issues', 'ISSUE-1.md'),
			`---\nprivate: [${privateCanary}\n---\n# ISSUE-1 Work\n`,
		)
		const manifest = await loadWorkManifest({ root })
		if (!manifest.ok) {
			throw new Error(manifest.error.message)
		}

		const invalidSource = await compileWorkGraph({ root, manifest: manifest.value })

		expect(invalidSource).toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_frontmatter' },
		})
		expect(JSON.stringify(invalidSource)).not.toContain(privateCanary)
	})

	it('rejects non-canonical primary work identifiers at the Markdown boundary', async () => {
		const root = await createProject()
		await writeFile(
			join(root, 'docs', 'issues', 'safe-name.md'),
			'---\nid: not an id\ntitle: Unsafe identifier\n---\nBody.\n',
		)
		const manifest = await loadWorkManifest({ root })
		if (!manifest.ok) {
			throw new Error(manifest.error.message)
		}

		await expect(compileWorkGraph({ root, manifest: manifest.value })).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_work_artifact' },
		})
	})

	it('rejects non-canonical parent and dependency identifiers before graph validation', async () => {
		const root = await createProject()
		await writeFile(
			join(root, 'docs', 'issues', 'ISSUE-1.md'),
			'---\nid: ISSUE-1\nparent: ../PRD-1\ndependencies: [ISSUE-2, bad dependency]\n---\n# ISSUE-1 Unsafe relations\n',
		)
		const manifest = await loadWorkManifest({ root })
		if (!manifest.ok) {
			throw new Error(manifest.error.message)
		}

		await expect(compileWorkGraph({ root, manifest: manifest.value })).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_work_artifact' },
		})
	})

	it('bounds comma-dense relation parsing before allocating the full split result', async () => {
		const root = await createProject()
		await writeFile(
			join(root, 'docs', 'issues', 'ISSUE-1.md'),
			`---\nid: ISSUE-1\ndependencies: ${'X,'.repeat(200_000)}X\n---\n# ISSUE-1 Dense relations\n`,
		)
		const manifest = await loadWorkManifest({ root })
		if (!manifest.ok) {
			throw new Error(manifest.error.message)
		}

		await expect(compileWorkGraph({ root, manifest: manifest.value })).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_work_artifact' },
		})
	})

	it('bounds dense acceptance extraction before allocating every bullet match', async () => {
		const root = await createProject()
		await writeFile(
			join(root, 'docs', 'issues', 'ISSUE-1.md'),
			`# ISSUE-1 Dense acceptance\n\n## Acceptance Criteria\n${'- x\n'.repeat(100_000)}`,
		)
		const manifest = await loadWorkManifest({ root })
		if (!manifest.ok) {
			throw new Error(manifest.error.message)
		}

		await expect(compileWorkGraph({ root, manifest: manifest.value })).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_work_artifact' },
		})
	})

	it('bounds aggregate graph validation diagnostics under invalid-edge fanout', async () => {
		const root = await createProject()
		const privateCanary = 'PRIVATE_GRAPH_BODY_/Users/operator/secret'
		await Promise.all(
			Array.from({ length: 101 }, async (_, index) =>
				writeFile(
					join(root, 'docs', 'issues', `ISSUE-${index + 1}.md`),
					`---\nid: ISSUE-${index + 1}\ntitle: Invalid edge\ndependencies: [MISSING-${index}]\n---\n${privateCanary}\n`,
				),
			),
		)
		const manifest = await loadWorkManifest({ root })
		if (!manifest.ok) {
			throw new Error(manifest.error.message)
		}

		const result = await compileWorkGraph({ root, manifest: manifest.value })

		expect(result.ok).toBe(false)
		if (result.ok) {
			return
		}
		expect(result.error.details).toHaveLength(101)
		expect(result.error.details?.at(-1)).toBe('Additional graph validation failures omitted.')
		expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(40_000)
		expect(JSON.stringify(result)).not.toContain(privateCanary)
	})

	it('does not expose malformed artifact fields or repository-relative source paths', async () => {
		const fieldCanary = 'PRIVATE_FIELD_/Users/operator/TOKEN=value'
		const invalidFields = [
			`---\nid: ISSUE-1\ndependencies: ["${fieldCanary}"]\n---\n# ISSUE-1 Work\n`,
			`---\nid: ISSUE-1\nevidence: ["${fieldCanary}"]\n---\n# ISSUE-1 Work\n`,
		] as const
		for (const source of invalidFields) {
			const root = await createProject()
			await writeFile(join(root, 'docs', 'issues', 'ISSUE-1.md'), source)
			const manifest = await loadWorkManifest({ root })
			if (!manifest.ok) {
				throw new Error(manifest.error.message)
			}

			const result = await compileWorkGraph({ root, manifest: manifest.value })

			expect(result).toMatchObject({
				ok: false,
				error: { type: 'work_contract_error', code: 'invalid_work_artifact' },
			})
			expect(JSON.stringify(result)).not.toContain(fieldCanary)
		}

		const sourceCanary = 'PRIVATE_SOURCE_PATH_TOKEN'
		const oversizedRoot = await createProject()
		await writeFile(
			join(oversizedRoot, 'docs', 'issues', `${sourceCanary}.md`),
			'x'.repeat(INPUT_LIMITS.sourceBytes + 1),
		)
		const oversizedManifest = await loadWorkManifest({ root: oversizedRoot })
		if (!oversizedManifest.ok) {
			throw new Error(oversizedManifest.error.message)
		}
		const oversized = await compileWorkGraph({
			root: oversizedRoot,
			manifest: oversizedManifest.value,
		})
		expect(oversized).toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'source_too_large' },
		})
		expect(JSON.stringify(oversized)).not.toContain(sourceCanary)

		const manifestRoot = await createProject()
		await writeFile(
			join(manifestRoot, 'work.yaml'),
			`version: 1\nproject: { id: example }\nsources: [{ kind: "${fieldCanary}", include: docs/issues/*.md }]\n`,
		)
		const invalidManifest = await loadWorkManifest({ root: manifestRoot })
		expect(invalidManifest).toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_work_manifest' },
		})
		expect(JSON.stringify(invalidManifest)).not.toContain(fieldCanary)
	})

	it('uses Tinyglobby brace, extglob, and negation semantics for source authority', async () => {
		const root = await createProject()
		await writeFile(
			join(root, 'work.yaml'),
			`version: 1
project: { id: example }
sources:
  - kind: issue
    include: ["docs/issues/{ISSUE,BUG}-@(1|2).md", "!docs/issues/BUG-2.md"]
`,
		)
		await Promise.all(
			['ISSUE-1', 'ISSUE-2', 'BUG-1', 'BUG-2'].map(async (id) =>
				writeFile(join(root, 'docs', 'issues', `${id}.md`), `# ${id} Work\n`),
			),
		)
		const manifest = await loadWorkManifest({ root })
		if (!manifest.ok) {
			throw new Error(manifest.error.message)
		}
		const compiled = await compileWorkGraph({ root, manifest: manifest.value })
		expect(compiled.ok && compiled.value.items.map(({ id }) => id)).toStrictEqual([
			'BUG-1',
			'ISSUE-1',
			'ISSUE-2',
		])
	})

	it('supports an exact-file source include without treating the file as a directory', async () => {
		const root = await createProject()
		await writeFile(join(root, 'docs', 'issues', 'ISSUE-1.md'), '# ISSUE-1 Exact\n')
		await writeFile(
			join(root, 'work.yaml'),
			'version: 1\nproject: { id: example }\nsources: [{ kind: issue, include: docs/issues/ISSUE-1.md }]\n',
		)
		const manifest = await loadWorkManifest({ root })
		if (!manifest.ok) {
			throw new Error(manifest.error.message)
		}

		await expect(compileWorkGraph({ root, manifest: manifest.value })).resolves.toMatchObject({
			ok: true,
			value: { items: [{ id: 'ISSUE-1' }] },
		})
	})

	it('preserves leading negative-extglob source inclusion semantics', async () => {
		const root = await createProject()
		await writeFile(join(root, 'docs', 'issues', 'ISSUE-1.md'), '# ISSUE-1 Included\n')
		await writeFile(join(root, 'docs', 'issues', 'notes.txt'), 'excluded')
		await writeFile(
			join(root, 'work.yaml'),
			'version: 1\nproject: { id: example }\nsources: [{ kind: issue, include: "docs/issues/!(*.txt)" }]\n',
		)
		const manifest = await loadWorkManifest({ root })
		if (!manifest.ok) {
			throw new Error(manifest.error.message)
		}

		await expect(compileWorkGraph({ root, manifest: manifest.value })).resolves.toMatchObject({
			ok: true,
			value: { items: [{ id: 'ISSUE-1' }] },
		})
	})

	it('expands literal directories, deduplicates overlap, and excludes directory descendants', async () => {
		const root = await createProject()
		await mkdir(join(root, 'docs', 'issues', 'drafts'), { recursive: true })
		await writeFile(join(root, 'docs', 'issues', 'ISSUE-1.md'), '# ISSUE-1 Included once\n')
		await writeFile(
			join(root, 'docs', 'issues', 'drafts', 'ISSUE-2.md'),
			'# ISSUE-2 Excluded draft\n',
		)
		await writeFile(
			join(root, 'work.yaml'),
			`version: 1
project: { id: example }
sources:
  - kind: issue
    include:
      - docs/issues
      - docs/issues/ISSUE-1.md
      - docs/issues/*.md
      - "!docs/issues/drafts"
`,
		)
		const manifest = await loadWorkManifest({ root })
		if (!manifest.ok) {
			throw new Error(manifest.error.message)
		}

		await expect(compileWorkGraph({ root, manifest: manifest.value })).resolves.toMatchObject({
			ok: true,
			value: { items: [{ id: 'ISSUE-1' }] },
		})
	})
})
