// Automations: schedules (routines and reminders), page watches, webhooks and account triggers.
// Code outside this folder imports only from here.
export { AccountTriggers } from "./account-triggers";
export { automationsFeature } from "./feature";
export { automationRoutes } from "./routes";
export {
  addPausedRoutines,
  copyUpcomingReminders,
  pauseSchedulesOf,
  ScheduleError,
  ScheduleService,
} from "./schedules";
export { AUTOMATION_TOOLS } from "./tools";
export { addPausedWatches, pauseTriggersOf, TriggerError, TriggerService } from "./triggers";
