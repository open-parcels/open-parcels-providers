#!/bin/sh
# Tags the current commit vX.Y.Z and builds the release tarball the server vendors.
# Usage: tools/release.sh <X.Y.Z>   (then: git push origin main vX.Y.Z; gh release create ...)
set -eu
version=${1:?usage: tools/release.sh <X.Y.Z>}
case "$version" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "version must be X.Y.Z" >&2; exit 2 ;;
esac
if [ -n "$(git status --porcelain)" ]; then
  echo "working tree is not clean" >&2
  exit 1
fi
git tag -a "v$version" -m "open-parcels-providers $version"
out="open-parcels-providers-$version.tgz"
git archive --format=tar.gz --prefix=open-parcels-providers/ -o "$out" "v$version"
sha256sum "$out"
