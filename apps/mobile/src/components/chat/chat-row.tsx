import { useEffect, type ReactNode } from "react";
import { View } from "react-native";
import { RowContext } from "@/components/chat/foldable-text";

/** A row of the chat list, which tells its messages where they are and the list that it's there. */
export function Row({
  index,
  rendered,
  children,
}: {
  index: number;
  rendered: Set<number>;
  children: ReactNode;
}) {
  useEffect(() => {
    rendered.add(index);
    return () => void rendered.delete(index);
  }, [index, rendered]);
  return (
    <RowContext.Provider value={index}>
      <View>{children}</View>
    </RowContext.Provider>
  );
}
