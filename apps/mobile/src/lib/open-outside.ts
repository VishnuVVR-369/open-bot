import * as WebBrowser from "expo-web-browser";
import { Alert, Linking } from "react-native";

/** Opens a link from a page outside the app: web links in a browser tab, mail in the mail app. */
export async function openOutside(url: string) {
  try {
    if (url.startsWith("mailto:")) await Linking.openURL(url);
    else await WebBrowser.openBrowserAsync(url);
  } catch {
    Alert.alert("Couldn't open the link", url);
  }
}
