import "server-only";
import { appRoutes } from "@/features/app-shell/server";
import { notificationRoutes } from "@/features/notifications/server";
import { approvalRoutes } from "@/features/approvals/server";
import { automationRoutes } from "@/features/automations/server";
import { chatRoutes } from "@/features/chat/server";
import { computerRoutes } from "@/features/computer/server";
import { fileRoutes } from "@/features/files/server";
import { homeRoutes } from "@/features/home/server";
import { integrationRoutes } from "@/features/integrations/server";
import { memoryRoutes } from "@/features/memory/server";
import { pageRoutes } from "@/features/pages/server";
import { settingsRoutes } from "@/features/settings/server";
import { skillRoutes } from "@/features/skills/server";
import { taskRoutes } from "@/features/tasks/server";
import { teammateRoutes } from "@/features/teammates/server";
import { vaultRoutes } from "@/features/vault/server";
import { os } from "./rpc";

/** The API (`contract` in `@open-bot/api`), for the browser and the phone. */
export const router = os.router({
  app: appRoutes(),
  ...computerRoutes(),
  home: homeRoutes(),
  ...teammateRoutes(),
  ...settingsRoutes(),
  ...integrationRoutes(),
  ...chatRoutes(),
  ...automationRoutes(),
  skills: skillRoutes(),
  tasks: taskRoutes(),
  vault: vaultRoutes(),
  memory: memoryRoutes(),
  files: fileRoutes(),
  notifications: notificationRoutes(),
  pages: pageRoutes(),
  approvals: approvalRoutes(),
});
