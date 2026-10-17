# Release preparation and publication

Release the four packages together from their `dist` directories. Core must reach
the public npm registry before its exact-version dependents. The workspace root
stays private development tooling. All distributed packages use the MIT license.

## Runtime and package versions

Node.js 24.22.0 is the minimum supported runtime, selected from the
[latest LTS release](https://nodejs.org/en/about/previous-releases) on 2026-10-18.
CI checks that exact version plus the latest Node 24 and 26 on Linux and Windows.
Changing the minimum requires updating root/package `engines`, this policy and the
CI matrix together. Node 22 is outside the supported range.

Use Node 24 types for packed-consumer checks. The development DOM toolchain uses
newer Node declarations; `@types/node-lts` is the alias that keeps the consumer
check on the supported LTS declarations. Keep that alias on the minimum runtime's
major when changing the support policy. Modern browser bundles target ES2022;
the Node minimum applies to Node usage and repository tooling.

For each release, update all four workspace package versions together. Update
the three exact `@slop-lab/part` dependency versions, refresh `package-lock.json`
with `npm install --package-lock-only --ignore-scripts`, and update the changelog
and current-version examples. Preserve historical changelog entries.

The build generates each package's `dist/version.js` and `dist/version.d.ts` from
its own `package.json`. Context provenance and agent/ACP/MCP identities use those
modules. Do not add a separate runtime version literal or edit generated files.

## Prepare and verify the release

Use a clean checkout and install the locked dependencies:

```sh
node --version
npm ci
npm run release:check
```

`release:check` runs formatting, strict TS/JS checks, architecture checks, the
complete test suite, seven isolated consumers, packing and release metadata
validation. Consumer fixtures install only the selected local tarballs and compile
portable declarations without Node ambient types. Node consumers use Node 24
declarations. Failures must be fixed before publishing; successful test names are
hidden by the reporter, and all test counts remain visible.

The release gate verifies synchronized versions and core dependencies, public npm
configuration, MIT metadata and identical LICENSE files, generated runtime versions,
required distribution files, package contents and actual tarball integrity/checksums.
It does not publish. It requires the tarballs created by `pack:local` to match the
current distributions.

Also run the browser and resource checks:

```sh
npx playwright install chromium
npm run test:browser
npm run measure
npm run measure:ui
npm audit
```

On Linux, use `npx playwright install --with-deps chromium` to install browser system
dependencies. CI runs the actual Chromium interaction suite on Linux/Node 24.
Performance measurements describe their fixture and environment; core import must
create no new active resources. Live provider checks are opt-in, use configured
credentials and incur provider usage; follow [provider smoke](provider-smoke.md)
when provider behavior changes.

Review the changelog, package READMEs and API documentation for the intended release
scope. Experimental API status and unsupported adapter capabilities remain explicit.
Commit the complete release preparation and verify a clean working tree. Record
the tested commit and do not rebuild or change files between tarball verification
and publication.

## Publish the verified tarballs

Verify npm authentication and permission to publish under `@slop-lab`. Public scoped
packages need public access; see the
[npm publication instructions](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/).
Each package sets `publishConfig.access` and the public registry explicitly.

Use the absolute, versioned tarball paths printed by `npm run pack:local`. If using
relative paths, include the `./` prefix, for example `./artifacts/package.tgz`, so
npm treats the argument as a local file rather than a package or GitHub spec. Inspect publication
with `npm publish <tarball-path> --dry-run --access public`, then publish the
**verified core tarball**:

```sh
npm publish <core-tarball-path> --access public
npm view @slop-lab/part@<version> version --registry=https://registry.npmjs.org/
```

After the exact core version is visible, publish the verified plugin, Node and
browser tarballs in that order using `npm publish <tarball-path> --access public`.
These tarballs were packed from `packages/*/dist` and install with compiled files
at the package root. Publishing the root workspace or workspace source directories
would bypass the verified distribution layout. A version bump requires rebuilding,
repacking and rerunning the gate; an already published version cannot be replaced.

## Verify the registry release

Check each package's exact version, `latest` tag, public access and core dependency.
In a fresh directory, install the exact registry versions and run a core import,
an agent/tool flow and the `part-mock-provider --help` executable. Build a browser
consumer using its `.js` subpaths and `styles.css`, and check declaration resolution.
These checks exercise registry delivery; local consumer checks exercise tarballs.

Once all four packages and registry checks succeed, tag the tested release commit
as `v<version>` and publish release notes from the changelog with the four tarballs
and their `.sha256` files. Push the commit/tag and create the GitHub release as the
explicit publication step.

If publication stops partway through, inspect registry versions before retrying.
Continue with the remaining verified tarballs, or prepare a new patch release for
changed contents. Do not republish or overwrite a published version.
