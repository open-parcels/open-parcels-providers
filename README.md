# open-parcels-providers

The official providers of [open-parcels](https://github.com/open-parcels/open-parcels), the
self-hosted parcel and order tracking server: one folder per provider, listed by the repo manifest
[`open-parcels-repo.json`](open-parcels-repo.json).

Every open-parcels image ships a pinned release of this repository as its built-in providers, so
the Home Assistant app and offline installs have every official carrier without installing
anything.

## Layout

| Path | What |
|---|---|
| `open-parcels-repo.json` | The repo manifest (format 1): every provider (`id`, `kind`, `folder`), themes and consumers |
| `providers/<id>/` | One provider: `open-parcels-provider.json` (what it is, every host it may reach), its code and email rules |
| `providers/<id>/test/` | Its tests, run by the server's test suite against recorded, made-up answers |
| `providers/<id>/fixtures/` | Made-up fixtures (`fixtures/email/*.eml`); never real tracking numbers, names or addresses |

## Versions

One version for the whole repository: every change to `main` is released as a tag `vX.Y.Z`
with the release tarball attached. A provider's manifest carries no version of its own. The
server pins one release (version and SHA-256) and vendors its tarball.

## Developing a provider

Providers are built and tested by the server for now (the provider SDK package comes later, see
the server's `docs/official-providers-repo.md`). Clone both repositories side by side, then in the
server checkout:

```sh
OPENPARCELS_PROVIDERS_DIR=../open-parcels-providers npm run providers   # lay out this checkout
npm run gate                                                           # format, lint, types, tests
```

See [`AGENT.md`](AGENT.md) for the rules.

## Licence

Public domain ([The Unlicense](LICENSE)), like the server.
