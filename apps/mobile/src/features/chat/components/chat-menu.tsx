import type { ChatSummary } from "@open-bot/api";
import { safe } from "@orpc/client";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { Archive, Pencil, SquarePen, Star } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert, View, StyleSheet } from "react-native";
import { Button } from "@/components/button";
import { Sheet, SheetItem } from "@/components/sheet";
import { Text } from "@/components/text";
import { TextField } from "@/components/text-field";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { queryKeys } from "@/lib/query";
import { useColors, space } from "@/theme";

/**
 * What you can do with a chat: start another, make it the main chat, rename it, or archive it. Renaming happens in the
 * same sheet, so its field gets the keyboard (a second sheet opening as this one closes doesn't).
 */
export function ChatMenu({
  open,
  onClose,
  chat,
  onNewChat,
}: {
  open: boolean;
  onClose: () => void;
  chat: ChatSummary;
  onNewChat: () => void;
}) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  useEffect(() => {
    if (open) setRenaming(false);
  }, [open]);
  const makeMain = async () => {
    onClose();
    const result = await safe(api.chats.makeMain({ chatId: chat.id }));
    if (result.error) {
      Alert.alert("Couldn't change the main chat", errorMessage(result.error));
      return;
    }
    void queryClient.invalidateQueries({ queryKey: queryKeys.chats });
    void queryClient.invalidateQueries({ queryKey: queryKeys.chat(chat.id) });
  };
  const archive = () => {
    onClose();
    Alert.alert(
      "Archive this chat?",
      "It's hidden from your chats. Its history stays, and teammates keep what they learned.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Archive",
          style: "destructive",
          onPress: async () => {
            const result = await safe(api.chats.archive({ chatId: chat.id }));
            if (result.error) {
              Alert.alert("Couldn't archive it", errorMessage(result.error));
              return;
            }
            void queryClient.invalidateQueries({ queryKey: queryKeys.chats });
            router.back();
          },
        },
      ],
    );
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={renaming ? "Rename chat" : undefined}
      testID="chat-menu-sheet"
    >
      {renaming ? (
        <RenameForm chat={chat} onDone={onClose} />
      ) : (
        <>
          <SheetItem
            icon={<SquarePen size={20} color={colors.foreground} />}
            label={chat.kind === "direct" ? "New chat" : "New group"}
            onPress={onNewChat}
            testID="menu-new-chat"
          />
          {chat.kind === "direct" && !chat.main && (
            <SheetItem
              icon={<Star size={20} color={colors.foreground} />}
              label="Make this the main chat"
              onPress={makeMain}
              testID="menu-make-main"
            />
          )}
          <SheetItem
            icon={<Pencil size={20} color={colors.foreground} />}
            label="Rename"
            onPress={() => setRenaming(true)}
            testID="menu-rename"
          />
          <SheetItem
            icon={<Archive size={20} color={colors.destructive} />}
            label="Archive"
            destructive
            onPress={archive}
            testID="menu-archive"
          />
        </>
      )}
    </Sheet>
  );
}

function RenameForm({ chat, onDone }: { chat: ChatSummary; onDone: () => void }) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(chat.title);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setProblem(null);
    const result = await safe(api.chats.rename({ chatId: chat.id, title: title.trim() }));
    setSaving(false);
    if (result.error) {
      setProblem(errorMessage(result.error));
      return;
    }
    void queryClient.invalidateQueries({ queryKey: queryKeys.chats });
    void queryClient.invalidateQueries({ queryKey: queryKeys.chat(chat.id) });
    onDone();
  }

  return (
    <View style={styles.sheetForm}>
      <TextField
        value={title}
        onChangeText={setTitle}
        maxLength={60}
        autoFocus
        selectTextOnFocus
        returnKeyType="done"
        onSubmitEditing={() => void save()}
        testID="rename-title"
      />
      {problem && (
        <Text variant="small" style={{ color: colors.destructive }}>
          {problem}
        </Text>
      )}
      <Button
        title="Save"
        onPress={() => void save()}
        disabled={!title.trim() || title.trim() === chat.title}
        busy={saving}
        testID="rename-save"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  sheetForm: { paddingHorizontal: space(5), gap: space(3) },
});
