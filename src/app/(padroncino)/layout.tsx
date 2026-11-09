import type { Metadata, Viewport } from "next";
import { ServiceWorkerRegister } from "@/components/padroncino/service-worker-register";

// Carrier PWA (D104): the manifest and the service worker belong to /padroncino only, so customers
// are never offered to install the carrier app.
export const metadata: Metadata = {
  manifest: "/padroncino/manifest.webmanifest",
  applicationName: "Transigo Partner",
  appleWebApp: { capable: true, title: "Transigo", statusBarStyle: "default" },
  icons: {
    icon: [{ url: "/padroncino/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/padroncino/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#0B3B8C",
  viewportFit: "cover",
};

export default function CarrierLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <ServiceWorkerRegister />
    </>
  );
}
