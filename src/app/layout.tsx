import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import CfAnalytics from "@/components/CfAnalytics";
import { inter, merriweather, jetbrainsMono } from "@/components/ui/fonts";
import { SITE_TITLE, SITE_DESCRIPTION, SITE_URL } from "@/lib/config";
import { lightHex, darkHex } from "@/settings.mjs";
import "./theme.css";
import "@/styles/prism.css";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: SITE_TITLE, template: `%s | ${SITE_TITLE}` },
  description: SITE_DESCRIPTION,
  applicationName: SITE_TITLE,
  alternates: { canonical: SITE_URL },
  openGraph: {
    type: "website",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    url: SITE_URL,
    images: ["/placeholder-social.jpg"],
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: ["/placeholder-social.jpg"],
  },
  icons: { icon: "/astro.svg" },
  other: { "cf-2fa-verify": "ZgvmYR9oRtPxieJWHe0p" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { color: lightHex },
    { media: "(prefers-color-scheme: dark)", color: darkHex },
  ],
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html lang="en-us" className="scroll-smooth">
      <body
        className={`${inter.variable} ${merriweather.variable} ${jetbrainsMono.variable} antialiased min-h-screen font-serif leading-normal`}
      >
        <div className="mx-auto max-w-prose px-5 py-5">
          <Header />
          <main>{children}</main>
          <Footer />
        </div>
        <CfAnalytics nonce={nonce} />
      </body>
    </html>
  );
}
