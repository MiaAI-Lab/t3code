#!/usr/bin/env bash
# Fork only: builds the server archives this desktop app uploads to SSH hosts.
# linux-x64 builds here; linux-arm64 builds on an arm64 host (default spark5) from the same commit.
# Output: release/remote-runtime/{VERSION,SHA256SUMS,t3-<version>-<platform>.tar.gz}
# usage: scripts/mia-build-remote-runtime.sh [arm64-host]
set -euo pipefail

ARM_HOST="${1:-spark5}"
ARM_CHECKOUT="src/t3code-mia"
ARM_NODE_DIR=".local/opt/node-v26.12.1-linux-arm64/bin"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Commit your changes first: both archives are built from HEAD." >&2
  exit 1
fi
COMMIT="$(git rev-parse HEAD)"
BASE_VERSION="$(node -p 'require("./apps/server/package.json").version')"
STAMP="$(git log -1 --format=%cd --date=format:%Y%m%d%H%M%S)"
VERSION="$BASE_VERSION-mia.$STAMP.g$(git rev-parse --short=9 HEAD)"
OUT="$REPO_ROOT/release/remote-runtime"
WORK="$REPO_ROOT/release/remote-runtime-work"
echo "[mia] Building server archives $VERSION"

# The hosts these archives reach (LAN machines) ship libatomic1; bundling it needs patchelf.
command -v patchelf >/dev/null || export T3CODE_CLI_SYSTEM_LIBATOMIC=1

build_x64() {
  vp run --filter t3 build
  node apps/server/scripts/cli.ts build-exe
  vp run build:resource-monitor
  rm -rf "$WORK/x64" && mkdir -p "$WORK/x64/rm/linux-x64" "$WORK/x64/out"
  cp native/resource-monitor/target/release/t3-resource-monitor "$WORK/x64/rm/linux-x64/"
  node scripts/build-cli-archive.ts --platform linux --arch x64 --version "$VERSION" \
    --resource-monitor-dir "$WORK/x64/rm" --output-dir "$WORK/x64/out"
}

build_arm64() {
  git push -q -f "$ARM_HOST:$ARM_CHECKOUT" "$COMMIT:refs/heads/mia-remote-runtime"
  ssh -o BatchMode=yes "$ARM_HOST" "bash -s" -- "$COMMIT" "$VERSION" <<REMOTE
set -euo pipefail
export PATH="\$HOME/.cargo/bin:\$HOME/$ARM_NODE_DIR:\$HOME/.local/bin:\$PATH"
cd "\$HOME/$ARM_CHECKOUT"
git checkout -q --detach "\$1"
export PATH="\$PWD/node_modules/.bin:\$PATH"
command -v pnpm >/dev/null || npm install -g --prefix "\$HOME/.local" pnpm@12.14.0
[ -x node_modules/.bin/vp ] || pnpm install --frozen-lockfile
command -v patchelf >/dev/null || export T3CODE_CLI_SYSTEM_LIBATOMIC=1
vp i
vp run --filter t3 build
node apps/server/scripts/cli.ts build-exe
vp run build:resource-monitor
rm -rf "\$HOME/src/mia-runtime" && mkdir -p "\$HOME/src/mia-runtime/rm/linux-arm64"
cp native/resource-monitor/target/release/t3-resource-monitor "\$HOME/src/mia-runtime/rm/linux-arm64/"
node scripts/build-cli-archive.ts --platform linux --arch arm64 --version "\$2" \
  --resource-monitor-dir "\$HOME/src/mia-runtime/rm" --output-dir "\$HOME/src/mia-runtime/out"
REMOTE
  rm -rf "$WORK/arm64" && mkdir -p "$WORK/arm64"
  scp -q "$ARM_HOST:src/mia-runtime/out/t3-$VERSION-linux-arm64.tar.gz" "$WORK/arm64/"
}

mkdir -p "$WORK"
build_arm64 >"$WORK/arm64.log" 2>&1 &
ARM_PID=$!
build_x64
if ! wait "$ARM_PID"; then
  echo "[mia] arm64 build on $ARM_HOST failed; see $WORK/arm64.log" >&2
  tail -n 30 "$WORK/arm64.log" >&2
  exit 1
fi

rm -rf "$OUT" && mkdir -p "$OUT"
cp "$WORK/x64/out/t3-$VERSION-linux-x64.tar.gz" "$WORK/arm64/t3-$VERSION-linux-arm64.tar.gz" "$OUT/"
(cd "$OUT" && sha256sum t3-*.tar.gz >SHA256SUMS)
printf '%s\n' "$VERSION" >"$OUT/VERSION"
echo "[mia] Server archives ready in $OUT"
ls -la "$OUT"
