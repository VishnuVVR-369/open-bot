#!/usr/bin/env bash
# Builds every video asset the landing page uses from the launch video project.
#
#   apps/site/.media/tour/v1/  adaptive HLS stream and MP4 fallback, uploaded to R2 (scripts/upload-media.sh)
#   apps/site/public/media/    small files served with the site: hero loop, posters, captions, scrub thumbnails
#
# Usage: apps/site/scripts/encode-media.sh [path/to/open-bot-video]
# Files under tour/v1 never change once published. Encode a new cut into v2 and point the site at it.
set -euo pipefail

VIDEO_PROJECT="${1:-$HOME/Desktop/Coding/Projects/open-bot-video}"
TOUR="$VIDEO_PROJECT/out/open-bot-voiceover.mp4"
CAPTIONS="$VIDEO_PROJECT/out/open-bot-voiceover.srt"
REC="$VIDEO_PROJECT/public/rec"

SITE="$(cd "$(dirname "$0")/.." && pwd)"
STREAM="$SITE/.media/tour/v1"
PUBLIC="$SITE/public/media"

for f in "$TOUR" "$CAPTIONS" "$REC/hero-screen.mp4"; do
  [[ -f "$f" ]] || { echo "Missing $f" >&2; exit 1; }
done
command -v ffmpeg >/dev/null || { echo "ffmpeg is required" >&2; exit 1; }

rm -rf "$STREAM" "$PUBLIC"
mkdir -p "$STREAM" "$PUBLIC"
FF=(ffmpeg -hide_banner -loglevel error -stats -y)

echo "==> HLS: 1080p60, 720p60 and 480p30 with shared AAC audio"
# Keyframes every 2 s in every rendition, so 4 s segments line up and quality switches are seamless.
# Video and audio must both start at exactly 0, or players begin inside a gap and Safari can stall there:
# no B-frames (their reordering delay pushes the first frame later), and the audio input is offset by the
# AAC encoder's 1024-sample priming (21.3 ms at 48 kHz) so the encoded audio starts at 0 too.
(
  cd "$STREAM"
  "${FF[@]}" -i "$TOUR" -itsoffset 0.0213333 -i "$TOUR" \
    -filter_complex "[0:v]split=3[a][b][c];[a]null[v1080];[b]scale=-2:720:flags=lanczos[v720];[c]fps=30,scale=-2:480:flags=lanczos[v480]" \
    -map "[v1080]" -map "[v720]" -map "[v480]" -map 1:a \
    -c:v libx264 -preset slow -profile:v high -pix_fmt yuv420p -bf 0 \
    -force_key_frames "expr:gte(t,n_forced*2)" -sc_threshold 0 \
    -crf:v:0 20 -maxrate:v:0 6000k -bufsize:v:0 12000k \
    -crf:v:1 21 -maxrate:v:1 3500k -bufsize:v:1 7000k \
    -crf:v:2 22 -maxrate:v:2 1400k -bufsize:v:2 2800k \
    -c:a aac -b:a 128k -ac 2 \
    -f hls -hls_time 4 -hls_playlist_type vod -hls_segment_type fmp4 \
    -hls_flags independent_segments -hls_fmp4_init_filename init.mp4 \
    -hls_segment_filename "%v/seg-%03d.m4s" -master_pl_name master.m3u8 \
    -var_stream_map "v:0,agroup:aud,name:1080p v:1,agroup:aud,name:720p v:2,agroup:aud,name:480p a:0,agroup:aud,name:audio,default:yes" \
    "%v/index.m3u8"
)

echo "==> MP4 fallback and download"
"${FF[@]}" -i "$TOUR" -c:v libx264 -preset slow -profile:v high -pix_fmt yuv420p \
  -crf 20 -maxrate 6000k -bufsize 12000k -c:a aac -b:a 128k -ac 2 \
  -movflags +faststart "$STREAM/open-bot-tour.mp4"

echo "==> Captions"
"${FF[@]}" -i "$CAPTIONS" "$PUBLIC/tour-captions.vtt"

echo "==> Scrub thumbnails: one every 2 s, 256x144, in a single sprite"
duration=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$TOUR")
count=$(awk -v d="$duration" 'BEGIN { print int((d + 1.999) / 2) }')
cols=8
rows=$(((count + cols - 1) / cols))
"${FF[@]}" -i "$TOUR" -vf "fps=1/2,scale=256:144:flags=lanczos,tile=${cols}x${rows}" \
  -frames:v 1 -q:v 4 "$PUBLIC/tour-thumbs.jpg"
awk -v n="$count" -v cols="$cols" -v d="$duration" 'function ts(s) {
    return sprintf("%02d:%02d:%06.3f", int(s / 3600), int(s % 3600 / 60), s - int(s / 60) * 60)
  }
  BEGIN {
    print "WEBVTT\n"
    for (i = 0; i < n; i++) {
      end = (i + 1) * 2 > d ? d : (i + 1) * 2
      printf "%s --> %s\ntour-thumbs.jpg#xywh=%d,%d,256,144\n\n", ts(i * 2), ts(end), (i % cols) * 256, int(i / cols) * 144
    }
  }' >"$PUBLIC/tour-thumbs.vtt"

echo "==> Hero loop: Milo working live on Google Flights, cropped to 16:9, 10 s, seamless"
# Takes 11 s, plays seconds 1-11, and crossfades the last second into seconds 0-1 so the end meets the start.
loop_filter="[0:v]trim=start=72:end=83,setpts=PTS-STARTPTS,crop=2880:1620:0:0,scale=1920:1080:flags=lanczos,fps=30,format=yuv420p,split[x][y];
  [x]trim=start=1:end=11,setpts=PTS-STARTPTS[main];
  [y]trim=start=0:end=1,setpts=PTS-STARTPTS[head];
  [main][head]xfade=transition=fade:duration=1:offset=9,format=yuv420p[out]"
"${FF[@]}" -i "$REC/hero-screen.mp4" -filter_complex "$loop_filter" -map "[out]" -an \
  -c:v libsvtav1 -preset 4 -crf 36 -g 300 -movflags +faststart "$PUBLIC/hero-loop.av1.mp4"
"${FF[@]}" -i "$REC/hero-screen.mp4" -filter_complex "$loop_filter" -map "[out]" -an \
  -c:v libx264 -preset slow -profile:v high -crf 25 -g 60 -movflags +faststart "$PUBLIC/hero-loop.h264.mp4"

echo "==> Hero poster: the loop's first frame, for the first paint and reduced motion"
"${FF[@]}" -i "$PUBLIC/hero-loop.h264.mp4" -frames:v 1 -q:v 2 "$SITE/.media/hero-poster.png"
avifenc -q 60 -s 4 "$SITE/.media/hero-poster.png" "$PUBLIC/hero-poster.avif" >/dev/null
"${FF[@]}" -i "$SITE/.media/hero-poster.png" -q:v 3 "$PUBLIC/hero-poster.jpg"
rm "$SITE/.media/hero-poster.png"

echo "==> Screenshots for each chapter, from the 2x app recordings"
mkdir -p "$PUBLIC/shots"
while read -r name file at; do
  png="$SITE/.media/$name.png"
  "${FF[@]}" -ss "$at" -i "$REC/$file" -frames:v 1 "$png"
  for width in 1280 2240; do
    "${FF[@]}" -i "$png" -vf "scale=$width:-1:flags=lanczos" "$SITE/.media/$name-$width.png"
    avifenc -q 62 -s 4 "$SITE/.media/$name-$width.png" "$PUBLIC/shots/$name-$width.avif" >/dev/null
  done
  cwebp -quiet -q 82 "$SITE/.media/$name-1280.png" -o "$PUBLIC/shots/$name-1280.webp"
  rm "$png" "$SITE/.media/$name"-*.png
done <<'SHOTS'
job create-teammate.mp4 6
watch hero-chat.mp4 126
takeover takeover.mp4 17.5
approval approve.mp4 87
swarm swarm.mp4 64
SHOTS

echo
du -sh "$STREAM" "$PUBLIC"/* | sed "s|$SITE/||"
