import { Copy, Download } from "lucide-react";
import { BotAvatar } from "@/components/bot-avatar";
import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AutomationsView } from "@/features/automations";
import { MemoryManager } from "@/features/memory";
import { SkillsList } from "@/features/skills";
import type { TeammatePage } from "../server/service";
import { AllowedRules } from "./allowed-rules";
import { BotDangerZone } from "./bot-danger-zone";
import { BotForm } from "./bot-form";
import { ChatList } from "./chat-list";
import { DuplicateBotDialog } from "./duplicate-bot";
import { InstructionsProposal } from "./instructions-proposal";
import { Spending } from "./spending";

const TABS = ["profile", "memory", "skills", "automations", "spending", "chats"];

/** A teammate's page: its profile, memory, skills, automations, spending and chats, one tab each. */
export function TeammateView({ teammate, tab }: { teammate: TeammatePage; tab?: string }) {
  const { bot, revision, chats: botChats, proposal, rules } = teammate;

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
      <Tabs defaultValue={tab && TABS.includes(tab) ? tab : "profile"} className="gap-6">
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
            editing={{ botId: bot.id, revision }}
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
          <BotDangerZone botId={bot.id} name={bot.name} isLead={bot.isLead} />
        </TabsContent>
        <TabsContent value="memory" className="flex flex-col gap-8">
          <MemoryManager botId={bot.id} name={bot.name} />
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
          <ChatList chats={botChats} botId={bot.id} botName={bot.name} />
        </TabsContent>
      </Tabs>
    </Page>
  );
}
