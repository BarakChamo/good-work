# Extraction provenance

This repository was extracted as a clean public project from host commit
`d6a7dbae89e72ea4c8f5ab2ffa3c9c8dccbb839b` on 2026-09-08.

The import intentionally excludes the host product's source, planning history,
local state, generated projections, and Git history. It retains only the Work
CLI/kernel, schemas, canonical skill, optional plugin, relevant evaluations, and
the tests needed to preserve their public contracts.

Existing internal consumers migrate by installing the public package, retaining
their committed `work.yaml` project UUID and completion ledger, draining old
package processes, reinstalling the skill, and running `work doctor` plus
`work sync --apply`. The stored legacy provider namespace remains readable for
compatibility even though it is not part of the public product identity.
