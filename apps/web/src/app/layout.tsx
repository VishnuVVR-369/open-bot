import type { Metadata, Viewport } from "next";
import { Familjen_Grotesk, JetBrains_Mono, Onest } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

const onest = Onest({ variable: "--font-onest", subsets: ["latin"] });
const familjen = Familjen_Grotesk({ variable: "--font-familjen", subsets: ["latin"] });
const jetbrains = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "open-bot", template: "%s · open-bot" },
  description: "Your AI teammates and the computer they share.",
  icons: { apple: "/icons/apple-touch-icon.png" },
  // Added to an iPhone's home screen, it opens full screen like an app.
  appleWebApp: { capable: true, title: "open-bot", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f4f6" },
    { media: "(prefers-color-scheme: dark)", color: "#0e0f12" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${onest.variable} ${familjen.variable} ${jetbrains.variable} h-full`}
    >
      <body className="h-full overflow-hidden">
        {/* In the desktop app, make room for the window controls before the first paint. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "if(window.openBotDesktop){document.documentElement.dataset.desktop=window.openBotDesktop.platform}",
          }}
        />
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
