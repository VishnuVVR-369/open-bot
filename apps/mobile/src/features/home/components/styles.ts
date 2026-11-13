import { StyleSheet } from "react-native";
import { space } from "@/theme";

/** Styles more than one part of Home uses. */
export const shared = StyleSheet.create({
  noteTag: { flexDirection: "row", alignItems: "center", gap: space(1) },
  mark: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
});
