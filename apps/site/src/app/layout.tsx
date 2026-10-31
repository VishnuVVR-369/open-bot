import type { Metadata, Viewport } from "next";
import { Familjen_Grotesk, JetBrains_Mono, Onest } from "next/font/google";
import { site } from "@/lib/site";
import { tour } from "@/lib/tour";
import "./globals.css";

const onest = Onest({ variable: "--font-onest", subsets: ["latin"] });
const familjen = Familjen_Grotesk({ variable: "--font-familjen", subsets: ["latin"] });
const jetbrains = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: site.title,
  description: site.description,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: site.name,
    title: site.title,
    description: site.description,
    videos: [{ url: tour.download, type: "video/mp4", width: 1920, height: 1080 }],
  },
  twitter: { card: "summary_large_image", title: site.title, description: site.description },
};

export const viewport: Viewport = {
  themeColor: "#f3f4f6",
  colorScheme: "light",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${onest.variable} ${familjen.variable} ${jetbrains.variable}`}>
      <body>{children}</body>
    </html>
  );
}
