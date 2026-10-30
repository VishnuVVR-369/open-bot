#!/usr/bin/env bash
# Uploads the encoded tour (apps/site/.media/tour/v1) to a Cloudflare R2 bucket with the right
# content types and caching. Files under a version never change, so they are cached for a year.
#
# Usage: apps/site/scripts/upload-media.sh <bucket-name>
# Sign in first with: npx wrangler login
set -euo pipefail

BUCKET="${1:?Usage: upload-media.sh <bucket-name>}"
SITE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$SITE/.media"
VERSION_DIR="$ROOT/tour/v1"

[[ -f "$VERSION_DIR/master.m3u8" ]] || {
  echo "Nothing to upload: run apps/site/scripts/encode-media.sh first" >&2
  exit 1
}

IMMUTABLE="public, max-age=31536000, immutable"

content_type() {
  case "$1" in
    *.m3u8) echo "application/vnd.apple.mpegurl" ;;
    *.m4s) echo "video/iso.segment" ;;
    *.mp4) echo "video/mp4" ;;
    *) echo "application/octet-stream" ;;
  esac
}

files=()
while IFS= read -r file; do files+=("$file"); done < <(cd "$ROOT" && find tour -type f | sort)
echo "Uploading ${#files[@]} files to r2://$BUCKET"

for key in "${files[@]}"; do
  extra=()
  # The full video downloads instead of opening in a tab when someone picks "Download the tour".
  [[ "$key" == */open-bot-tour.mp4 ]] && extra=(--content-disposition 'attachment; filename="open-bot-tour.mp4"')
  npx --yes wrangler@4 r2 object put "$BUCKET/$key" --remote --file "$ROOT/$key" \
    --content-type "$(content_type "$key")" --cache-control "$IMMUTABLE" ${extra[@]+"${extra[@]}"} >/dev/null
  echo "  $key"
done

echo "Done. The site needs NEXT_PUBLIC_MEDIA_URL set to the bucket's public URL."
