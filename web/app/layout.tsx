import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
// Fonts ship with the `geist` package (next/font/local under the hood), so the
// build does not need fonts.googleapis.com, which the demo host cannot reach.
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Background } from "@/components/ui/background";
import { ServiceWorkerRegister } from "@/components/pwa/sw-register";
import { DemoBanner } from "@/components/demo/demo-banner";
import { DemoProvider } from "@/components/demo/demo-context";
import { isDemoMode } from "@/lib/demo";

const geistSans = GeistSans;
const geistMono = GeistMono;

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#0a0a0a",
};

export const metadata: Metadata = {
  title: "EmailDigest",
  description: "School mail assistant",
  manifest: "/manifest.json",
  applicationName: "EmailDigest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "EmailDigest",
  },
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  formatDetection: { telephone: false },
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Render per request so DEMO_MODE is read at runtime, not frozen at build.
  await connection();
  const demo = isDemoMode();
  return (
    <html lang="en" className={`dark ${geistSans.variable} ${geistMono.variable} h-full${demo ? " demo-mode" : ""}`}>
      <body className="h-full">
        <Background />
        {demo && <DemoBanner />}
        <DemoProvider demo={demo}>
          <TooltipProvider delay={600}>{children}</TooltipProvider>
        </DemoProvider>
        <Toaster
          position="top-center"
          offset={demo ? 56 : undefined}
          theme="dark"
          toastOptions={{
            style: { background: "rgba(20,20,24,0.9)", border: "1px solid rgba(255,255,255,0.08)", backdropFilter: "blur(16px)" },
          }}
        />
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
