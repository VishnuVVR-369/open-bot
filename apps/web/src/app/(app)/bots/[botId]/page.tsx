import { approvalRules, bots, chats } from "@open-bot/db";
import { Copy, Download } from "lucide-react";
import { and, asc, desc, eq, isNull, ne } from "drizzle-orm";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BotAvatar } from "@/components/bot-avatar";
import { AllowedRules } from "@/components/bots/allowed-rules";
import { DuplicateBotDialog } from "@/components/bots/duplicate-bot";
import { Button } from "@/components/ui/button";
import { BotDangerZone } from "@/components/bots/bot-danger-zone";
import { BotForm } from "@/components/bots/bot-form";
import { InstructionsProposal } from "@/components/bots/instructions-proposal";
import { MemoryEditor } from "@/components/bots/memory-editor";
import { Spending } from "@/components/bots/spending";
import { AutomationsView } from "@/components/automations/automations-view";
import { SkillsList } from "@/components/skills/skills-list";
import { Page } from "@/components/page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { db } from "@/lib/server/db";
import { pendingProposal } from "@/lib/server/queries";
import { ChatList } from "@/components/bots/chat-list";

export async function generateMetadata({ params }: PageProps<"/bots/[botId]">): Promise<Metadata> {
  const { botId } = await params;
  const [bot] = /^[0-9a-f-]{36}$/i.test(botId)
    ? await db.select({ name: bots.name }).from(bots).where(eq(bots.id, botId))
    : [];
  return { title: bot?.name ?? "Teammate" };
}

const TABS = ["profile", "memory", "skills", "automations", "spending", "chats"];

export default async function BotPage({ params, searchParams }: PageProps<"/bots/[botId]">) {
  const { botId } = await params;
  const { tab } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(botId)) notFound();
  const [bot] = await db
    .select()
    .from(bots)
    .where(and(eq(bots.id, botId), isNull(bots.archivedAt)));
  if (!bot) notFound();
  const botChats = await db
    .select({
      id: chats.id,
      kind: chats.kind,
      title: chats.title,
      lastActivityAt: chats.lastActivityAt,
    })
    .from(chats)
    .where(and(eq(chats.botId, botId), isNull(chats.archivedAt), ne(chats.kind, "helper")))
    .orderBy(desc(chats.lastActivityAt));
  const proposal = await pendingProposal(botId);
  const rules = await db
    .select({ id: approvalRules.id, kind: approvalRules.kind, pattern: approvalRules.pattern })
    .from(approvalRules)
    .where(eq(approvalRules.botId, botId))
    .orderBy(asc(approvalRules.createdAt));

  return (
    <Page
      title={
        <span className="flex items-center gap-3.5">
          <BotAvatar name={bot.name} color={bot.color} emoji={bot.emoji} size="lg" />
          <span className="flex flex-col">
            {bot.name}
            <span className="font-sans text-[14px] font-normal text-muted-foreground">
              {bot.role}
            </span>
          </span>
        </span>
      }
      actions={
        <div className="flex items-center gap-2">
          <Button variant="outline" asChild>
            <a href={`/api/bots/${bot.id}/export`} download data-testid="export-bot">
              <Download />
              Export
            </a>
          </Button>
          <DuplicateBotDialog
            bot={{ id: bot.id, name: bot.name }}
            trigger={
              <Button variant="outline" data-testid="duplicate-bot">
                <Copy />
                Duplicate
              </Button>
            }
          />
        </div>
      }
    >
      <Tabs
        defaultValue={typeof tab === "string" && TABS.includes(tab) ? tab : "profile"}
        className="gap-6"
      >
        {/* Six tabs don't fit a phone, so they scroll sideways there. */}
        <div className="-mx-5 overflow-x-auto px-5 [scrollbar-width:none] sm:mx-0 sm:px-0">
          <TabsList className="min-w-max">
            <TabsTrigger value="profile">Profile</TabsTrigger>
            <TabsTrigger value="memory">Memory</TabsTrigger>
            <TabsTrigger value="skills">Skills</TabsTrigger>
            <TabsTrigger value="automations">Automations</TabsTrigger>
            <TabsTrigger value="spending">Spending</TabsTrigger>
            <TabsTrigger value="chats">Chats</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="profile" className="flex flex-col gap-12">
          {proposal && (
            <InstructionsProposal
              proposal={proposal}
              name={bot.name}
              instructionsNow={bot.instructions}
            />
          )}
          <BotForm
            // Accepting a suggestion changes the instructions under the form.
            key={bot.updatedAt.toISOString()}
            botId={bot.id}
            submitLabel="Save changes"
            initial={{
              name: bot.name,
              role: bot.role,
              instructions: bot.instructions,
              color: bot.color,
              emoji: bot.emoji,
              autonomy: bot.autonomy,
            }}
          />
          <AllowedRules name={bot.name} rules={rules} />
          <BotDangerZone botId={bot.id} name={bot.name} isPrimary={bot.isPrimary} />
        </TabsContent>
        <TabsContent value="memory" className="flex flex-col gap-8">
          <MemoryEditor botId={bot.id} name={bot.name} />
        </TabsContent>
        <TabsContent value="skills">
          <SkillsList botId={bot.id} />
        </TabsContent>
        <TabsContent value="automations">
          <AutomationsView botId={bot.id} />
        </TabsContent>
        <TabsContent value="spending">
          <Spending botId={bot.id} name={bot.name} />
        </TabsContent>
        <TabsContent value="chats">
          <ChatList
            chats={botChats.map((chat) => ({
              ...chat,
              lastActivityAt: chat.lastActivityAt.toISOString(),
            }))}
            botId={bot.id}
            botName={bot.name}
          />
        </TabsContent>
      </Tabs>
    </Page>
  );
}
