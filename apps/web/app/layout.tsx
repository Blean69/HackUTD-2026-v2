import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Geist, Geist_Mono } from "next/font/google";
import { DataProvider } from "@/components/DataProvider";
import { PITCH, PRODUCT_NAME } from "@/lib/constants";
import "./globals.css";

const sans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const mono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const display = Bricolage_Grotesque({ variable: "--font-bricolage", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: `${PRODUCT_NAME}: your family's financial room`, template: `%s · ${PRODUCT_NAME}` },
  description: PITCH,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#edf3f0" },
    { media: "(prefers-color-scheme: dark)", color: "#08130f" },
  ],
};

// Runs before first paint so there is no light/dark flash.
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('keystone.theme');if(t!=='light'&&t!=='dark'){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.dataset.theme=t}catch(e){}})()`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${display.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full">
        <DataProvider>{children}</DataProvider>
      </body>
    </html>
  );
}
