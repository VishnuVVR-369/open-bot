import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { openOutside } from "@/lib/open-outside";
import { isPageAddress, parsePageMessage } from "@/lib/pages";
import { useColors } from "@/theme";

/**
 * A page, loaded from its own origin. Only the page itself loads here: any other address opens
 * outside the app, and the page never gets your session, storage or files.
 */
export function PageFrame({
  url,
  reloads,
  onMessage,
  onLoadEnd,
  onHttpError,
  onError,
  onRenderProcessGone,
}: {
  url: string;
  /** Changes whenever the page must load again, even at the same address. */
  reloads: number;
  onMessage: (event: WebViewMessageEvent) => void;
  onLoadEnd: () => void;
  onHttpError: (status: number) => void;
  onError: () => void;
  onRenderProcessGone: () => void;
}) {
  const colors = useColors();
  return (
    <WebView
      key={`${url}#${reloads}`}
      source={{ uri: url }}
      onMessage={onMessage}
      // Only the page itself loads here; any other address opens outside the app.
      onShouldStartLoadWithRequest={(request) => {
        // The page itself, or a place in it (its table of contents).
        if (isPageAddress(request.url, url)) return true;
        if (!request.isTopFrame) return false;
        const message = parsePageMessage(
          JSON.stringify({ source: "openbot-page", type: "open", url: request.url }),
        );
        if (message?.type === "open") void openOutside(message.url);
        return false;
      }}
      setSupportMultipleWindows={false}
      javaScriptCanOpenWindowsAutomatically={false}
      // Never your session: the page runs on its own origin with nothing of yours.
      sharedCookiesEnabled={false}
      thirdPartyCookiesEnabled={false}
      incognito
      domStorageEnabled={false}
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      geolocationEnabled={false}
      mediaPlaybackRequiresUserAction
      mixedContentMode={__DEV__ ? "compatibility" : "never"}
      forceDarkOn={false}
      overScrollMode="never"
      onLoadEnd={onLoadEnd}
      onHttpError={(event) => onHttpError(event.nativeEvent.statusCode)}
      onError={onError}
      onRenderProcessGone={(): void => {
        onRenderProcessGone();
      }}
      style={{ flex: 1, backgroundColor: colors.background }}
      containerStyle={{ backgroundColor: colors.background }}
      testID="page-webview"
    />
  );
}
