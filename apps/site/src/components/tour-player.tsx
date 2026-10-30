"use client";

// Loaded on demand: media-chrome and hls.js only run in the browser.
import HlsVideo from "hls-video-element/react";
import {
  MediaAirplayButton,
  MediaCaptionsButton,
  MediaControlBar,
  MediaController,
  MediaFullscreenButton,
  MediaLoadingIndicator,
  MediaMuteButton,
  MediaPipButton,
  MediaPlayButton,
  MediaPreviewChapterDisplay,
  MediaPreviewThumbnail,
  MediaPreviewTimeDisplay,
  MediaTimeDisplay,
  MediaTimeRange,
  MediaVolumeRange,
} from "media-chrome/react";
import {
  MediaCaptionsMenu,
  MediaPlaybackRateMenu,
  MediaRenditionMenu,
  MediaSettingsMenu,
  MediaSettingsMenuButton,
  MediaSettingsMenuItem,
} from "media-chrome/react/menu";
import { tour } from "@/lib/tour";

// Adaptive streaming: start at a quality most connections hold, never fetch more pixels than the player shows.
const hlsConfig = {
  capLevelToPlayerSize: true,
  abrEwmaDefaultEstimate: 3_000_000,
};

export default function TourPlayer({
  onMedia,
}: {
  onMedia: (media: HTMLVideoElement | null) => void;
}) {
  return (
    <MediaController className="tour-player" defaultDuration={tour.duration}>
      <HlsVideo
        slot="media"
        // preload comes before src: until someone presses play, only the playlist is fetched.
        preload="none"
        src={tour.stream}
        playsInline
        config={hlsConfig}
        ref={(el) => onMedia(el as unknown as HTMLVideoElement | null)}
      >
        <track kind="captions" src={tour.captions} srcLang="en" label="English" />
        <track kind="metadata" label="thumbnails" src={tour.thumbnails} default />
        <track kind="chapters" src="/media/tour-chapters.vtt" srcLang="en" default />
      </HlsVideo>

      <MediaLoadingIndicator slot="centered-chrome" noAutohide />
      <MediaPlayButton slot="centered-chrome" className="center-play" />

      <MediaSettingsMenu hidden anchor="auto">
        <MediaSettingsMenuItem>
          Speed
          <MediaPlaybackRateMenu slot="submenu" hidden>
            <div slot="title">Speed</div>
          </MediaPlaybackRateMenu>
        </MediaSettingsMenuItem>
        <MediaSettingsMenuItem>
          Quality
          <MediaRenditionMenu slot="submenu" hidden>
            <div slot="title">Quality</div>
          </MediaRenditionMenu>
        </MediaSettingsMenuItem>
        <MediaSettingsMenuItem>
          Captions
          <MediaCaptionsMenu slot="submenu" hidden>
            <div slot="title">Captions</div>
          </MediaCaptionsMenu>
        </MediaSettingsMenuItem>
      </MediaSettingsMenu>

      <div className="controls">
        <MediaControlBar>
          <MediaTimeRange>
            <MediaPreviewThumbnail slot="preview" />
            <MediaPreviewChapterDisplay slot="preview" />
            <MediaPreviewTimeDisplay slot="preview" />
          </MediaTimeRange>
        </MediaControlBar>
        <MediaControlBar>
          <MediaPlayButton />
          <MediaMuteButton />
          <MediaVolumeRange />
          <MediaTimeDisplay showDuration />
          <span className="spacer" />
          <MediaCaptionsButton />
          <MediaSettingsMenuButton />
          <MediaPipButton />
          <MediaAirplayButton />
          <MediaFullscreenButton />
        </MediaControlBar>
      </div>
    </MediaController>
  );
}
