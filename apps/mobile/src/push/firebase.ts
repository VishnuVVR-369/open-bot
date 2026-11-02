import Constants from "expo-constants";

/** Whether this build has a Firebase config, so it can get push notifications. */
export const hasFirebase = Constants.expoConfig?.extra?.firebase === true;
