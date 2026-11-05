#!/bin/sh
set -eu
home=${RIMEFOX_OCR_TEST_HOME:-$HOME}
home=$(cd "$home" && pwd -P)
root="$home/Library/Application Support/Rimefox/OCR"
check=$root
while [ "$check" != / ] && [ -n "$check" ]; do
  [ ! -L "$check" ] || { echo 'Refusing a symbolic-link installation path.' >&2; exit 1; }
  check=$(dirname "$check")
done
owner="$root/.rimefox-ocr-owner"
for managed in "$owner" "$root/registration-backup" "$root/versions"; do
  [ ! -L "$managed" ] || { echo 'Refusing a symbolic-link managed file or directory.' >&2; exit 1; }
done
if [ ! -f "$owner" ]; then echo 'No owned Rimefox OCR installation found. Nothing changed.'; exit 0; fi
[ "$(cat "$owner")" = 'com.rimefox.ocr:1' ] || { echo 'Invalid ownership marker.' >&2; exit 1; }
for browser in 'Google/Chrome' 'Microsoft Edge'; do
  case "$browser" in Google/Chrome) label=chrome ;; *) label=edge ;; esac
  file="$home/Library/Application Support/$browser/NativeMessagingHosts/com.rimefox.ocr.json"
  check=$file
  while [ "$check" != / ] && [ -n "$check" ]; do
    [ ! -L "$check" ] || { echo 'Refusing a symbolic-link manifest path.' >&2; exit 1; }
    check=$(dirname "$check")
  done
  if [ -f "$file" ]; then
    current=$(plutil -extract path raw -o - "$file" 2>/dev/null || true)
    case "$current" in "$root"/versions/*/rimefox-ocr-host)
      backup="$root/registration-backup/$label"
      [ ! -L "$backup.json" ] && [ ! -L "$backup.absent" ] || { echo 'Refusing a symbolic-link registration backup.' >&2; exit 1; }
      if [ -f "$backup.json" ]; then cp "$backup.json" "$file"; elif [ -f "$backup.absent" ]; then rm -f "$file"; fi ;;
      *) printf 'Leaving another host registration unchanged: %s\n' "$file" ;;
    esac
  fi
done
# Only fixed, product-managed subdirectories of the verified root may be removed.
for child in versions registration-backup; do
  target="$root/$child"
  [ "$target" = "$root/versions" ] || [ "$target" = "$root/registration-backup" ] || exit 1
  if [ -d "$target" ]; then
    [ -z "$(find "$target" -type l -print -quit)" ] || { echo 'Refusing to remove a directory containing symbolic links.' >&2; exit 1; }
    rm -rf "$target"
  fi
done
rm -f "$root/host-manifest.tmp" "$root/uninstall.sh" "$owner"
rmdir "$root" 2>/dev/null || true
echo 'Rimefox OCR removed. Browser extension and document library were not removed.'
