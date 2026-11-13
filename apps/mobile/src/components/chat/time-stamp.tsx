import { Text } from "@/components/text";
import { space } from "@/theme";

export function TimeStamp({ text }: { text: string }) {
  return (
    <Text
      variant="caption"
      muted
      style={{ textAlign: "center", marginBottom: space(4), fontWeight: "500" }}
    >
      {text}
    </Text>
  );
}
