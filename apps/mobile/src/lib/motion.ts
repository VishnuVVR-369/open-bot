import { useEffect, useState } from "react";
import { AccessibilityInfo, LayoutAnimation } from "react-native";

/** The app's motion timings, in milliseconds. */
export const durations = { micro: 150, layout: 220, sheet: 260 } as const;

let reduceMotion = false;
void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
  reduceMotion = value;
});
AccessibilityInfo.addEventListener("reduceMotionChanged", (value) => {
  reduceMotion = value;
});

/** Whether the phone asks for less motion ("Remove animations"). */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(reduceMotion);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduced);
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => subscription.remove();
  }, []);
  return reduced;
}

/** Animates the next layout change (something opening, closing or moving), unless motion is off. */
export function animateLayout(duration: number = durations.layout) {
  if (reduceMotion) return;
  LayoutAnimation.configureNext(
    LayoutAnimation.create(duration, LayoutAnimation.Types.easeInEaseOut, "opacity"),
  );
}
