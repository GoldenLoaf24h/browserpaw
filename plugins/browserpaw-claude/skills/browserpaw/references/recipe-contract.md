# Static Recipe Contract

Static recipes are client-neutral data under `assets/recipes/`. JSON recipes may be loaded by the Native runtime as bundled skills; Markdown host notes are dated hints and are not executable.

Do not store passwords, cookies, tokens, tab IDs, document IDs, temporary refs, screenshot coordinates, or user input.

Executable JSON must include:

- stable `id` matching the filename
- exact source URLs and attribution
- a closed input schema and output contract
- executable steps with concrete result paths
- independent verification steps
- two different validation inputs

Unreviewed JavaScript does not become executable by labeling its source `builtin`. The Native distribution accepts only reviewed bundled program bodies and the fixed `dom-extract` alias. A personal record cannot edit a builtin body.

Allowed automatic read-only steps are tool-specific. Network requests are GET-only and reject bodies or multipart data. DOM observation rejects dismissal and highlighting. Grep rejects automatic scrolling. Screenshots remain in memory and reject disk writes or page-mutating overlays.
