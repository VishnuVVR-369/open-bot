import * as Orientation from "expo-screen-orientation";
import { usePreventRemove } from "expo-router";
import { useCallback, useEffect } from "react";
import { BackHandler, Keyboard } from "react-native";

/**
 * The screen page may rotate, unlike the rest of the app. Rotating during a takeover keeps
 * landscape until you hand back or leave; leaving restores the app's lock.
 */
export function useScreenOrientation(owner: boolean, landscape: boolean) {
  useEffect(() => {
    const previous = Orientation.getOrientationLockAsync();
    void Orientation.unlockAsync();
    return () => {
      void previous.then((lock) => Orientation.lockAsync(lock));
    };
  }, []);
  useEffect(() => {
    if (owner && landscape) void Orientation.lockAsync(Orientation.OrientationLock.LANDSCAPE);
    else if (!owner) void Orientation.unlockAsync();
  }, [owner, landscape]);
}

/** While you hold the screen, going back asks you to hand it back instead of leaving. */
export function useHandBackOnLeave(owner: boolean, askHandBack: () => void) {
  const confirmBack = useCallback(() => {
    if (!owner) return false;
    Keyboard.dismiss();
    askHandBack();
    return true;
  }, [owner, askHandBack]);
  usePreventRemove(owner, () => {
    confirmBack();
  });
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", confirmBack);
    return () => sub.remove();
  }, [confirmBack]);
}
