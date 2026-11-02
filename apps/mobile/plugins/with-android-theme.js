// @ts-check
const {
  AndroidConfig,
  withAndroidColors,
  withAndroidColorsNight,
  withAndroidStyles,
} = require("expo/config-plugins");

const { assignColorValue } = AndroidConfig.Colors;
const { assignStylesValue } = AndroidConfig.Styles;

// Fonts expo-font bundles (see app.config.ts). Single faces, not its font family XML: that only
// has `app:` attributes, which the plain TextViews in alerts can't read.
const BODY = "@font/onest_400regular";
const BUTTON = "@font/onest_600semi_bold";
const DISPLAY = "@font/familjen_grotesk_600semi_bold";

/** `name:parent` → items. Alerts get the app's surface, ink, type and rounded corners. */
const STYLES = {
  "AppTheme:Theme.AppCompat.DayNight.NoActionBar": {
    colorAccent: "@color/colorAccent",
    alertDialogTheme: "@style/AppDialog",
    "android:alertDialogTheme": "@style/AppDialog",
    // React Native inflates an alert's title with the activity, so it reads this theme's.
    "android:windowTitleStyle": "@style/AppDialogTitle",
  },
  "AppDialog:Theme.AppCompat.DayNight.Dialog.Alert": {
    colorAccent: "@color/colorAccent",
    "android:colorBackground": "@color/dialogBackground",
    "android:textColorPrimary": "@color/dialogText",
    "android:textColorSecondary": "@color/dialogTextMuted",
    "android:fontFamily": BODY,
    dialogCornerRadius: "20dp",
    "android:dialogCornerRadius": "20dp",
    "android:windowTitleStyle": "@style/AppDialogTitle",
    buttonBarButtonStyle: "@style/AppDialogButton",
  },
  "AppDialogTitle:Base.DialogWindowTitle.AppCompat": {
    "android:textAppearance": "@style/AppDialogTitleText",
  },
  "AppDialogTitleText:TextAppearance.AppCompat.Title": {
    "android:fontFamily": DISPLAY,
    "android:textColor": "@color/dialogText",
  },
  // An alert's message has this style itself, which names sans-serif over the theme's font.
  // AppCompat views only show up in alerts here, so the app's own version replaces it.
  "TextAppearance.AppCompat.Subhead:Base.TextAppearance.AppCompat.Subhead": {
    "android:fontFamily": BODY,
  },
  "AppDialogButton:Widget.AppCompat.Button.ButtonBar.AlertDialog": {
    "android:fontFamily": BUTTON,
    "android:textAllCaps": "false",
    "android:textSize": "15sp",
  },
};

/**
 * @typedef {{ surface: string, foreground: string, mutedForeground: string, primary: string }} Colors
 * @param {Colors} colors
 */
const named = (colors) => ({
  colorPrimary: colors.primary,
  colorAccent: colors.primary,
  dialogBackground: colors.surface,
  dialogText: colors.foreground,
  dialogTextMuted: colors.mutedForeground,
});

/**
 * Gives the native theme the app's ink and surface colors, light and dark, so what Android draws
 * itself (alerts like "Sign out?", the text cursor and selection handles) matches the app instead
 * of using the stock teal.
 *
 * @type {import("expo/config-plugins").ConfigPlugin<{ light: Colors, dark: Colors }>}
 */
module.exports = function withAndroidTheme(config, { light, dark }) {
  const assign = (/** @type {Colors} */ colors) => (/** @type {any} */ config) => {
    for (const [name, value] of Object.entries(named(colors))) {
      config.modResults = assignColorValue(config.modResults, { name, value });
    }
    return config;
  };
  config = withAndroidColors(config, assign(light));
  config = withAndroidColorsNight(config, assign(dark));
  return withAndroidStyles(config, (config) => {
    for (const [style, items] of Object.entries(STYLES)) {
      const [name, parent] = style.split(":");
      for (const [item, value] of Object.entries(items)) {
        config.modResults = assignStylesValue(config.modResults, {
          add: true,
          parent: { name, parent },
          name: item,
          value,
        });
      }
    }
    return config;
  });
};
