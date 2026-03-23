"use client";

import Script from "next/script";

interface CfAnalyticsProps {
  nonce: string | undefined;
}

export default function CfAnalytics({ nonce }: CfAnalyticsProps) {
  return (
    <Script
      src="https://static.cloudflareinsights.com/beacon.min.js"
      data-cf-beacon='{"token": "8638462c7bdd4e4cb69c53e3cfebe7f5"}'
      strategy="afterInteractive"
      nonce={nonce}
      defer
    />
  );
}
