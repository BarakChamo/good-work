/**
 * @description Synchronizes versioned plugin, marketplace, skill, and runtime identity assets.
 *
 * @module work/release-assets
 * @file Release-assets.ts
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

interface PackageIdentity {
	readonly name: string
	readonly repository: string
	readonly version: string
}

const readUtf8 = async (path: string): Promise<string | null> =>
	readFile(path, 'utf8').catch((error: unknown) => {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return null
		}
		throw error
	})

const parseRecord = (source: string, label: string): Record<string, unknown> => {
	const value: unknown = JSON.parse(source)
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new TypeError(`${label} must contain one JSON object.`)
	}
	return { ...value }
}

const loadIdentity = async (root: string): Promise<PackageIdentity> => {
	const source = await readFile(join(root, 'package.json'), 'utf8')
	const document = parseRecord(source, 'package.json')
	const repository = document.repository
	const repositoryUrl =
		typeof repository === 'object' &&
		repository !== null &&
		'url' in repository &&
		typeof repository.url === 'string'
			? repository.url
			: undefined
	const repositoryMatch =
		repositoryUrl === undefined
			? null
			: /^git\+https:\/\/github\.com\/([^/]+\/work)\.git$/u.exec(repositoryUrl)
	if (
		typeof document.name !== 'string' ||
		!/^@[^/]+\/work$/u.test(document.name) ||
		typeof document.version !== 'string' ||
		repositoryMatch?.[1] === undefined
	) {
		throw new TypeError(
			'package.json must declare the scoped Work package, version, and GitHub repository.',
		)
	}
	return { name: document.name, repository: repositoryMatch[1], version: document.version }
}

const json = (value: unknown): string => `${JSON.stringify(value, null, '\t')}\n`

const updatePluginManifest = (source: string, version: string): string => {
	const document = parseRecord(source, 'plugin manifest')
	const pluginInterface = document.interface
	return json({
		...document,
		version,
		author: { name: 'Work contributors' },
		...(typeof pluginInterface === 'object' &&
		pluginInterface !== null &&
		!Array.isArray(pluginInterface)
			? { interface: { ...pluginInterface, developerName: 'Work contributors' } }
			: {}),
	})
}

const updateClaudeMarketplace = (source: string, version: string): string => {
	const document = parseRecord(source, 'Claude marketplace')
	if (!Array.isArray(document.plugins)) {
		throw new TypeError('Claude marketplace must contain a plugins array.')
	}
	return json({
		...document,
		version,
		plugins: document.plugins.map((plugin) => {
			if (typeof plugin !== 'object' || plugin === null || Array.isArray(plugin)) {
				throw new TypeError('Claude marketplace plugin entries must be objects.')
			}
			return 'name' in plugin && plugin.name === 'work' ? { ...plugin, version } : plugin
		}),
	})
}

const updateExampleHookConfig = (source: string, identity: PackageIdentity): string => {
	const document = parseRecord(source, 'example work.json')
	return json({
		...document,
		$schema: `https://raw.githubusercontent.com/${identity.repository}/v${identity.version}/schemas/work.schema.json`,
	})
}

const updatePublicSchema = (source: string, identity: PackageIdentity): string => {
	const document = parseRecord(source, 'public work schema')
	return json({
		...document,
		$id: `https://raw.githubusercontent.com/${identity.repository}/v${identity.version}/schemas/work.schema.json`,
	})
}

const renderRuntimeIdentity = ({ name, repository, version }: PackageIdentity): string => `/**
 * @description Generated public package identity used by versioned runtime artifacts.
 *
 * @module work/release-identity
 * @file Release-identity.ts
 */

export const WORK_PACKAGE_NAME = '${name}'
export const WORK_REPOSITORY = '${repository}'
export const WORK_VERSION = '${version}'
export const WORK_SCHEMA_URL = \`https://raw.githubusercontent.com/\${WORK_REPOSITORY}/v\${WORK_VERSION}/schemas/work.schema.json\`
`

/** @description Makes every release-coupled asset match package.json or reports exact drift. */
export const synchronizeReleaseAssets = async (input: {
	readonly root: string
	readonly check: boolean
}): Promise<{ readonly changedPaths: readonly string[] }> => {
	const identity = await loadIdentity(input.root)
	const canonicalSkill = await readFile(join(input.root, 'skills/work/SKILL.md'), 'utf8')
	const canonicalCommands = await readFile(
		join(input.root, 'skills/work/references/commands.md'),
		'utf8',
	)
	const codexManifest = await readFile(
		join(input.root, 'plugins/work/.codex-plugin/plugin.json'),
		'utf8',
	)
	const claudeManifest = await readFile(
		join(input.root, 'plugins/work/.claude-plugin/plugin.json'),
		'utf8',
	)
	const claudeMarketplace = await readFile(
		join(input.root, '.claude-plugin/marketplace.json'),
		'utf8',
	)
	const exampleHookConfig = await readFile(join(input.root, 'examples/basic/work.json'), 'utf8')
	const publicSchema = await readFile(join(input.root, 'schemas/work.schema.json'), 'utf8')
	const desired = new Map<string, string>([
		['plugins/work/skills/work/SKILL.md', canonicalSkill],
		['plugins/work/skills/work/references/commands.md', canonicalCommands],
		[
			'plugins/work/.codex-plugin/plugin.json',
			updatePluginManifest(codexManifest, identity.version),
		],
		[
			'plugins/work/.claude-plugin/plugin.json',
			updatePluginManifest(claudeManifest, identity.version),
		],
		[
			'.claude-plugin/marketplace.json',
			updateClaudeMarketplace(claudeMarketplace, identity.version),
		],
		['examples/basic/work.json', updateExampleHookConfig(exampleHookConfig, identity)],
		['schemas/work.schema.json', updatePublicSchema(publicSchema, identity)],
		['src/release-identity.ts', renderRuntimeIdentity(identity)],
	])
	const changedPaths: string[] = []
	for (const [path, content] of desired) {
		const destination = join(input.root, path)
		if ((await readUtf8(destination)) === content) {
			continue
		}
		changedPaths.push(path)
		if (!input.check) {
			await mkdir(dirname(destination), { recursive: true })
			await writeFile(destination, content)
		}
	}
	changedPaths.sort()
	if (input.check && changedPaths.length > 0) {
		throw new Error(`Release assets are not synchronized: ${changedPaths.join(', ')}`)
	}
	return { changedPaths }
}
