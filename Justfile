set dotenv-load := false

default:
    @just --list

# Run the full test suite + typecheck
test:
    bun test
    bun run typecheck

# Build the Node-distributable CLI bundle
build:
    bun run build

# Build the browser playground bundle
build-playground:
    bun run build:playground

# Serve the playground at http://localhost:8733
serve-playground: build-playground
    cd docs && python3 -m http.server 8733

# Build, bump version (patch by default), publish to npm, push tags.
# Usage: `just publish` (patch) · `just publish minor` · `just publish major`
publish bump="patch":
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ -n "$(git status --porcelain)" ]]; then
        echo "error: working tree is dirty — commit or stash first" >&2
        exit 1
    fi
    if ! npm whoami > /dev/null 2>&1; then
        echo "error: not logged in to npm — run \`npm login\` first" >&2
        exit 1
    fi
    bun test
    bun run typecheck
    bun run build
    npm version {{ bump }} -m "release: v%s"
    npm publish
    git push --follow-tags
