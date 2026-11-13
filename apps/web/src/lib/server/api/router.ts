import "server-only";
import { getAppState, getProfile, listNotifications } from "../queries";
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
import * as api from "./services";

/** The API (`contract` in `@open-bot/api`), for the browser and the phone. */
export const router = os.router({
  app: {
    state: os.app.state.handler(({ context }) =>
      getAppState({ name: context.user.name, email: context.user.email }),
    ),
  },
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
  profile: {
    get: os.profile.get.handler(() => getProfile()),
  },
  memory: memoryRoutes(),
  files: fileRoutes(),
  notifications: {
    list: os.notifications.list.handler(() => listNotifications()),
    markRead: os.notifications.markRead.handler(({ input }) => api.markNotificationsRead(input)),
  },
  pages: pageRoutes(),
  approvals: approvalRoutes(),
  egress: {
    status: os.egress.status.handler(() => api.getEgressStatus()),
    setMode: os.egress.setMode.handler(({ input }) => api.setEgressMode(input)),
    setPhoneMode: os.egress.setPhoneMode.handler(({ input }) => api.setPhoneEgressMode(input)),
    devices: os.egress.devices.handler(() => api.listEgressDevices()),
    registerDevice: os.egress.registerDevice.handler(({ input }) =>
      api.registerEgressDevice(input),
    ),
    revokeDevice: os.egress.revokeDevice.handler(({ input }) => api.revokeEgressDevice(input)),
  },
});
