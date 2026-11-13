import { CalendarClock, CalendarDays, Eye, Mail, Webhook } from "lucide-react-native";

export const TRIGGER_ICONS = {
  schedule: CalendarClock,
  watch: Eye,
  webhook: Webhook,
  gmail: Mail,
  calendar: CalendarDays,
} as const;
