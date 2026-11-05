import { requireOptionalNativeModule } from "expo";

export interface NativeShare {
  text: string;
  subject: string | null;
}

interface ShareIntent {
  /** The share the app was opened with, once; null when there's none (or it was taken). */
  take(): NativeShare | null;
  addListener(event: "share", listener: (share: NativeShare) => void): { remove(): void };
}

/** Null in a build without the module (an older dev client), so sharing just isn't offered. */
export default requireOptionalNativeModule<ShareIntent>("OpenBotShareIntent");
