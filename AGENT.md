Be extra careful when talking to real-world services like Amazon: conservative rate limits, generous
delays, backoff, many failsafes, and stop fast when a response looks wrong. A network error must
never trigger a new sign-in.

# open-parcels-providers: notes for agents

The official providers of open-parcels. Read the server repository's `AGENT.md`,
`docs/glossary.md`, `docs/provider-manifest-and-sandbox.md` and `docs/official-providers-repo.md`
first: the server defines the provider API, the manifest format and the gate.

## Layout and conventions

- **One folder per provider:** `providers/<id>/`, the folder name equal to the manifest's `id`.
  It holds `open-parcels-provider.json`, the code, `email-rules.ts` where the provider reads
  emails, `test/` and `fixtures/<kind>/`. A folder is complete on its own.
- **The repo manifest lists every provider** (`open-parcels-repo.json`: `id`, `kind` (`code` or
  `declarative`), `folder`), and `themes` and `consumers` the same way. A folder not listed, or a
  listed folder missing, fails the server's test.
- **Providers import only the provider API** (`src/provider/api.js` of the server). The server's
  ESLint enforces it. A helper several providers need goes into the API's `kit/`, in the server;
  a helper only one provider uses stays in its folder.
- **Every host a provider reaches is in its manifest** with the reason; requests to any other host
  are refused.
- **Tests and fixtures contain made-up values only.** Never commit real tracking numbers, order
  numbers, names, addresses, emails or coordinates. Build made-up secrets from parts.
- **Use the glossary's words** (provider, connection, parcel, tracking number, sign in, ...).
- **Don't name the projects an endpoint was learned from** in code, docs or commit messages.

## The gate

There is no separate build here yet: the server lays out a checkout of this repository and runs its
own gate over it (format, ESLint, knip, tsc, vitest, build). From the server checkout:

```sh
OPENPARCELS_PROVIDERS_DIR=../open-parcels-providers npm run providers
npm run gate
```

Install the pre-commit hook once per clone: `git config core.hooksPath tools/hooks`. Never bypass it
with `--no-verify`.

## Releases

- **One version for the repository**, tags `vX.Y.Z`; a provider has no version of its own.
- **Every change to `main` is released**: bump with `tools/release.sh <version>`, which tags the
  commit and builds the tarball (`git archive`, prefix `open-parcels-providers/`) that is
  attached to the GitHub release and printed with its SHA-256.
- **The server pins one release:** copy the tarball to the server's
  `server/vendor/open-parcels-providers-<version>.tgz`, set `openParcelsProviders` in
  `server/package.json` to the version and SHA-256, run its gate, commit both in one step.

## GitHub Actions

Workflows never run under this account. A workflow keeps only `workflow_dispatch` active; its
automatic triggers stay commented out with the reason written above them.
