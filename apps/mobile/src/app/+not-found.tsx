import { router, Stack } from "expo-router";
import { Link2Off } from "lucide-react-native";
import { NotFound } from "@/components/states";

/** A link into the app that leads nowhere, an old one say: say so plainly, and go Home. */
export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "" }} />
      <NotFound
        icon={Link2Off}
        title="This link doesn't lead anywhere"
        body="It may be old, or something it pointed to was removed."
        action="Go to Home"
        onAction={() => router.replace("/")}
      />
    </>
  );
}
