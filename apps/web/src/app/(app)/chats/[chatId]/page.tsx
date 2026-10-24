import { ChatView } from "@/components/chat/chat-view";

export default async function ChatPage({ params }: PageProps<"/chats/[chatId]">) {
  const { chatId } = await params;
  return <ChatView key={chatId} chatId={chatId} />;
}
