import { toolDisplay, type ToolIcon } from "@open-bot/domain";
import {
  Bell,
  CalendarClock,
  CalendarDays,
  CreditCard,
  Eye,
  History,
  KeyRound,
  ListTodo,
  Mail,
  MessageCircleQuestion,
  NotebookText,
  Sparkles,
  UserRound,
  Webhook,
  Wrench,
} from "lucide-react-native";
import type { StepIcon } from "./step";

/** Every icon meaning in `@open-bot/domain`'s tool display, drawn with lucide, as on the web. */
const TOOL_ICONS: Record<ToolIcon, StepIcon> = {
  tool: Wrench,
  notification: Bell,
  email: Mail,
  schedule: CalendarClock,
  calendar: CalendarDays,
  question: MessageCircleQuestion,
  tasks: ListTodo,
  suggestion: Sparkles,
  skill: Sparkles,
  watch: Eye,
  webhook: Webhook,
  history: History,
  profile: UserRound,
  key: KeyRound,
  payment: CreditCard,
  notes: NotebookText,
};

/** The icon for a step of the tool `name`. */
export function toolIcon(name: string): StepIcon {
  return TOOL_ICONS[toolDisplay(name).icon];
}
