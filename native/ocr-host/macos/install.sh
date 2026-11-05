#!/bin/sh
# Current-user system OCR preview. No sudo, network download or security-policy changes.
set -eu
set -f
cd "$(dirname "$0")"
package=$(pwd -P)
ids=''
replace=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --extension-id) [ "$#" -ge 2 ] || exit 2; ids="$ids $2"; shift 2 ;;
    --replace-existing) replace=1; shift ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
if [ -z "$ids" ]; then
  printf 'Paste the extension ID from Rimefox Settings > OCR (Chrome/Edge IDs separated by commas): '
  IFS= read -r ids
fi
ids=$(printf '%s' "$ids" | tr ',;' '  ')
count=0
for id in $ids; do
  case "$id" in *[!a-p]*) echo 'Invalid extension ID: only lowercase a-p is allowed.' >&2; exit 2 ;; esac
  [ "${#id}" -eq 32 ] || { echo 'An extension ID must have 32 characters.' >&2; exit 2; }
  count=$((count + 1))
done
[ "$count" -gt 0 ] || { echo 'No extension ID supplied.' >&2; exit 2; }
[ "$(uname -s)" = Darwin ] || { echo 'This installer requires macOS.' >&2; exit 2; }
major=$(sw_vers -productVersion | cut -d. -f1)
[ "$major" -ge 12 ] || { echo 'macOS 12 or later is required.' >&2; exit 2; }
home=${RIMEFOX_OCR_TEST_HOME:-$HOME}
home=$(cd "$home" && pwd -P)
root="$home/Library/Application Support/Rimefox/OCR"
assert_path() {
  check=$1
  while [ "$check" != / ] && [ -n "$check" ]; do
    [ ! -L "$check" ] || { printf 'Refusing symbolic-link installation path: %s\n' "$check" >&2; exit 1; }
    check=$(dirname "$check")
  done
}
assert_path "$root"
owner="$root/.rimefox-ocr-owner"
assert_path "$owner"
assert_path "$root/registration-backup"
if [ -d "$root" ] && [ ! -f "$owner" ] && [ -n "$(ls -A "$root")" ]; then
  echo 'Destination is not an owned Rimefox OCR installation.' >&2; exit 1
fi
if [ -f "$owner" ] && [ "$(cat "$owner")" != 'com.rimefox.ocr:1' ]; then echo 'Invalid ownership marker.' >&2; exit 1; fi
expected=$(awk '$2 == "rimefox-ocr-host" {print $1}' "$package/SHA256SUMS")
case "$expected" in *[!0-9a-fA-F]*|'') echo 'Invalid or missing SHA256SUMS entry.' >&2; exit 1 ;; esac
[ "${#expected}" -eq 64 ] || exit 1
actual=$(shasum -a 256 "$package/rimefox-ocr-host" | awk '{print $1}')
[ "$actual" = "$expected" ] || { echo 'SHA-256 mismatch. Nothing was installed.' >&2; exit 1; }
# Preflight both browsers before modifying either registration.
for browser in 'Google/Chrome' 'Microsoft Edge'; do
  file="$home/Library/Application Support/$browser/NativeMessagingHosts/com.rimefox.ocr.json"
  assert_path "$file"
  if [ -f "$file" ]; then
    current=$(plutil -extract path raw -o - "$file" 2>/dev/null || true)
    case "$current" in "$root"/versions/*/rimefox-ocr-host) ;; *)
      [ "$replace" -eq 1 ] || { printf 'Another host is registered at %s. Review it before using --replace-existing.\n' "$file" >&2; exit 1; } ;;
    esac
  fi
done
assert_path "$root/versions/$expected"
assert_path "$root/host-manifest.tmp"
assert_path "$root/uninstall.sh"
mkdir -p "$root/versions/$expected" "$root/registration-backup"
printf '%s\n' 'com.rimefox.ocr:1' > "$owner"
binary="$root/versions/$expected/rimefox-ocr-host"
assert_path "$binary"
if [ ! -f "$binary" ]; then
  # ditto preserves extended attributes, including quarantine. Never silently remove it.
  ditto "$package/rimefox-ocr-host" "$binary"
  chmod 700 "$binary"
elif [ "$(shasum -a 256 "$binary" | awk '{print $1}')" != "$expected" ]; then
  echo 'Installed connector checksum differs. Close browsers and repair the installation.' >&2; exit 1
fi
cp "$package/uninstall.sh" "$root/uninstall.sh"
chmod 700 "$root/uninstall.sh"
if ! "$binary" --diagnose; then
  echo 'The connector could not start. Review macOS Privacy & Security and the preview instructions. No browser host was registered; no security setting was changed. Retry after resolving the individual-program prompt.' >&2
  exit 1
fi
tmp="$root/host-manifest.tmp"
# IDs were validated above; intentional word splitting passes each ID as a separate argument.
"$binary" --host-manifest "$binary" $ids > "$tmp"
for browser in 'Google/Chrome' 'Microsoft Edge'; do
  case "$browser" in Google/Chrome) label=chrome ;; *) label=edge ;; esac
  folder="$home/Library/Application Support/$browser/NativeMessagingHosts"
  file="$folder/com.rimefox.ocr.json"
  backup="$root/registration-backup/$label"
  assert_path "$backup.json"
  assert_path "$backup.absent"
  assert_path "$file.tmp"
  foreign=0
  if [ -f "$file" ]; then
    current=$(plutil -extract path raw -o - "$file" 2>/dev/null || true)
    case "$current" in "$root"/versions/*/rimefox-ocr-host) ;; *) foreign=1 ;; esac
  fi
  if [ "$foreign" -eq 1 ] || { [ ! -f "$backup.json" ] && [ ! -f "$backup.absent" ]; }; then
    if [ -f "$file" ]; then cp "$file" "$backup.json"; rm -f "$backup.absent"; else : > "$backup.absent"; fi
  fi
  mkdir -p "$folder"
  cp "$tmp" "$file.tmp"
  mv "$file.tmp" "$file"
done
rm -f "$tmp"
printf 'System OCR preview installed at %s\nReturn to Rimefox Settings > OCR, grant permission and click Recheck.\n' "$root"
