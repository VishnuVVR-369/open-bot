import { permanentRedirect } from "next/navigation";

/** Schedules live on the Automations page now. */
export default function SchedulesPage() {
  permanentRedirect("/automations");
}
