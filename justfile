set positional-arguments

# Start the complete browser playground, with optional providers and ChatGPT sign-in.
example: _deps
    npm run preview

# Start the local SIWC web PoC.
siwc: _deps
    npm run example:siwc

# Run the CLI example with signin, models, or ask.
siwc-cli *args: _deps
    npm run example:siwc:cli -- "$@"

# Start the website identity example with a registered SIWC client.
siwc-website: _deps
    npm run example:siwc:website

_deps:
    @if [ ! -f node_modules/typescript/bin/tsc ] || [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then npm ci; fi
