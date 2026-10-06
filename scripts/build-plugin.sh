#!/usr/bin/env bash
# Build the quota-pilot library for this machine's OS into dist/<goos>-<goarch>/quota-pilot.<ext>,
# with its page embedded: run `bun run build` in ui/ first. Release builds pass the version;
# on macOS a goarch other than the machine's cross-compiles (arm64 to amd64 or back).
#   scripts/build-plugin.sh [version] [goarch]
set -euo pipefail
kit=$(cd "$(dirname "$0")/.." && pwd)
version=${1:-dev}
goos=$(go env GOOS)
goarch=${2:-$(go env GOARCH)}
case $goos in
  darwin) ext=dylib ;;
  linux) ext=so ;;
  *) echo "Builds run on macOS or Linux." >&2; exit 1 ;;
esac
test -s "$kit/plugin/page/index.html" || { echo "No page: run bun run build in ui/ first." >&2; exit 1; }

export CGO_ENABLED=1 GOARCH=$goarch
if [ "$goos" = darwin ]; then
  # clang names the architectures as macOS does.
  arch=$goarch
  [ "$arch" = amd64 ] && arch=x86_64
  export CC="clang -arch $arch"
fi
out=$kit/dist/$goos-$goarch
mkdir -p "$out"
cd "$kit/plugin"
# No VCS stamp: the version is set here, and a build needs no git (a source archive, or a container
# whose user does not own the checkout).
go build -buildmode=c-shared -trimpath -buildvcs=false -ldflags "-s -w -X main.version=$version" -o "$out/quota-pilot.$ext" .
rm -f "$out/quota-pilot.h"
echo "$out/quota-pilot.$ext"
