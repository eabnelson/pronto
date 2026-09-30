#!/bin/bash
# Builds a release binary and assembles Pronto.app.
#
#   scripts/bundle.sh <outdir> [--sign-identity <identity>] [--universal]
#
# The app is ad-hoc signed by default (`codesign --sign -`). The release
# workflow passes a Developer ID identity with --sign-identity (or the
# SIGN_IDENTITY environment variable) and notarizes separately.
set -euo pipefail

usage() {
  echo "usage: $0 <outdir> [--sign-identity <identity>] [--universal]" >&2
  exit 64
}

[[ $# -ge 1 ]] || usage
out_dir="$1"; shift
identity="${SIGN_IDENTITY:--}"
universal=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sign-identity) [[ $# -ge 2 ]] || usage; identity="$2"; shift 2 ;;
    --universal) universal=1; shift ;;
    *) usage ;;
  esac
done

package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$package_dir/../.." && pwd)"
version="$(plutil -extract version raw -o - "$repo_root/package.json")"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] || { echo "error: bad version '$version' in package.json" >&2; exit 1; }
build_number="${BUILD_NUMBER:-$version}"

build_args=(-c release --package-path "$package_dir" --product ProntoMenuBar)
if [[ $universal == 1 ]]; then build_args+=(--arch arm64 --arch x86_64); fi

echo "==> Building ProntoMenuBar $version (release)"
swift build "${build_args[@]}"
bin_dir="$(swift build "${build_args[@]}" --show-bin-path)"

mkdir -p "$out_dir"
out_dir="$(cd "$out_dir" && pwd)"
app="$out_dir/Pronto.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin_dir/ProntoMenuBar" "$app/Contents/MacOS/Pronto"

cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>Pronto</string>
  <key>CFBundleExecutable</key><string>Pronto</string>
  <key>CFBundleIdentifier</key><string>dev.pronto.menubar</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Pronto</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$build_number</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Copyright © Pronto contributors. MIT License.</string>
  <key>NSQuitAlwaysKeepsWindows</key><false/>
</dict>
</plist>
PLIST
plutil -lint "$app/Contents/Info.plist" >/dev/null
printf 'APPL????' > "$app/Contents/PkgInfo"

echo "==> Signing with identity '$identity'"
sign_args=(--force --options runtime --sign "$identity")
if [[ "$identity" == "-" ]]; then sign_args+=(--timestamp=none); else sign_args+=(--timestamp); fi
codesign "${sign_args[@]}" "$app"
codesign --verify --strict --verbose=1 "$app"

echo "==> $app"
