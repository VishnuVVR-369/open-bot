import { useEffect, useState } from "react";
import { Dimensions, Keyboard } from "react-native";

/**
 * How much of the screen the keyboard covers, from its top edge to the bottom of the screen.
 * Android draws the app edge to edge, so the window doesn't shrink for the keyboard and the screen
 * makes room itself. The reported `height` leaves out the navigation bar under the keyboard, so
 * it's measured from where the keyboard starts instead.
 */
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", ({ endCoordinates }) =>
      setHeight(Math.max(0, Dimensions.get("screen").height - endCoordinates.screenY)),
    );
    const hide = Keyboard.addListener("keyboardDidHide", () => setHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return height;
}
