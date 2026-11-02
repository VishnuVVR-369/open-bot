// Background handlers must be registered before the app, so a notification or one of its buttons
// can be handled while the app is closed (Android starts a headless JS task for it).
import "./src/push/background";
import "expo-router/entry";
