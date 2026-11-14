import { Copy, Download } from "lucide-react";
import { TeammateAvatar } from "@/components/teammate-avatar";
import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AutomationsView } from "@/features/automations";
import { MemoryManager } from "@/features/memory";
import { SkillsList } from "@/features/skills";
import type { TeammatePage } from "../server/service";
import { AllowedRules } from "./allowed-rules";
import { TeammateDangerZone } from "./teammate-danger-zone";
import { TeammateForm } from "./teammate-form";
import { ChatList } from "./chat-list";
import { DuplicateTeammateDialog } from "./duplicate-teammate";
import { InstructionsProposal } from "./instructions-proposal";
import { Spending } from "./spending";

const TABS = ["profile", "memory", "skills", "automations", "spending", "chats"];

/** A teammate's page: its profile, memory, skills, automations, spending and chats, one tab each. */
export function TeammateView({ teammate: page, tab }: { teammate: TeammatePage; tab?: string }) {
  const { teammate, revision, chats: teammateChats, proposal, rules } = page;

  return (
    <Page
      title={
        <span className="flex items-center gap-3.5">
          <TeammateAvatar
            name={teammate.name}
            color={teammate.color}
            emoji={teammate.emoji}
            size="lg"
          />
          <span className="flex flex-col">
            {teammate.name}
            <span className="font-sans text-[14px] font-normal text-muted-foreground">
              {teammate.role}
            </span>
          </span>
        </span>
      }
      actions={
        <div className="flex items-center gap-2">
          <Button variant="outline" asChild>
            <a href={`/api/teammates/${teammate.id}/export`} download data-testid="export-teammate">
              <Download />
              Export
            </a>
          </Button>
          <DuplicateTeammateDialog
            teammate={{ id: teammate.id, name: teammate.name }}
            trigger={
              <Button variant="outline" data-testid="duplicate-teammate">
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
              name={teammate.name}
              instructionsNow={teammate.instructions}
            />
          )}
          <TeammateForm
            // Accepting a suggestion changes the instructions under the form.
            key={teammate.updatedAt.toISOString()}
            editing={{ teammateId: teammate.id, revision }}
            submitLabel="Save changes"
            initial={{
              name: teammate.name,
              role: teammate.role,
              instructions: teammate.instructions,
              color: teammate.color,
              emoji: teammate.emoji,
              autonomy: teammate.autonomy,
            }}
          />
          <AllowedRules name={teammate.name} rules={rules} />
          <TeammateDangerZone
            teammateId={teammate.id}
            name={teammate.name}
            isLead={teammate.isLead}
          />
        </TabsContent>
        <TabsContent value="memory" className="flex flex-col gap-8">
          <MemoryManager teammateId={teammate.id} name={teammate.name} />
        </TabsContent>
        <TabsContent value="skills">
          <SkillsList teammateId={teammate.id} />
        </TabsContent>
        <TabsContent value="automations">
          <AutomationsView teammateId={teammate.id} />
        </TabsContent>
        <TabsContent value="spending">
          <Spending teammateId={teammate.id} name={teammate.name} />
        </TabsContent>
        <TabsContent value="chats">
          <ChatList chats={teammateChats} teammateId={teammate.id} teammateName={teammate.name} />
        </TabsContent>
      </Tabs>
    </Page>
  );
}
