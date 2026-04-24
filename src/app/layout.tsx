import type { Metadata, Viewport } from "next";
import { Be_Vietnam_Pro, Plus_Jakarta_Sans } from "next/font/google";
import BottomNav from "@/components/BottomNav";
import "./globals.css";
import SupabaseAuthBootstrap from "@/components/SupabaseAuthBootstrap";
import AddToHomeScreenPrompt from "@/components/AddToHomeScreenPrompt";

const beVietnamPro = Be_Vietnam_Pro({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-headline",
  display: "swap",
});

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-label",
  display: "swap",
});

export const metadata: Metadata = {
  title: "BookBuddy — Kids Book Sharing",
  description:
    "List one, borrow many. A peer-to-peer book sharing library for kids in your housing society.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "BookBuddy",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#417000",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${beVietnamPro.variable} ${plusJakarta.variable} h-full`}
    >
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-full flex flex-col pb-20">
        <SupabaseAuthBootstrap />
        {process.env.NEXT_PUBLIC_ENV === "uat" && (
          <div className="fixed top-2 right-2 z-[100] bg-secondary text-on-secondary text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-widest shadow">
            UAT
          </div>
        )}
        {children}
        <AddToHomeScreenPrompt />
        <BottomNav />
      </body>
    </html>
  );
}
