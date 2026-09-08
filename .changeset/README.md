# Changesets

Add a changeset for every user-visible CLI, schema, hook, skill, plugin, state,
or compatibility change. Tests, internal refactors, and documentation-only
changes may omit one.

Run `bun run changeset`, choose the Work package, select the semantic version
impact, and explain the user-visible change. The release workflow turns merged
changesets into a version pull request; publishing is a separate staged,
human-approved operation.
