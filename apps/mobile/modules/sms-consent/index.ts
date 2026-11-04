import { requireNativeModule } from "expo";

interface SmsConsent {
  start(): Promise<void>;
  stop(): void;
  addListener(
    event: "code",
    listener: (event: { code: string | null }) => void,
  ): { remove(): void };
}
export default requireNativeModule<SmsConsent>("OpenBotSmsConsent");
