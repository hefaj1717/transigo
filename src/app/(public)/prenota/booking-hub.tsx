"use client";

import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { BookingServiceTabs } from "@/components/site/booking-service-tabs";
import {
  BOOKING_TABS,
  bookingTab,
  type BookingService,
} from "@/lib/public/booking-tabs";
import type { WizardSession } from "@/lib/booking/session";
import type { PortersPrefill } from "@/lib/booking/porters/state";
import type { StoragePrefill } from "@/lib/booking/storage/state";
import type { PortersOptions } from "@/lib/booking/porters/server";
import type { StorageOptions } from "@/lib/booking/storage/server";
import type { BookingOptions } from "@/lib/booking/server";
import { Wizard } from "./wizard";
import { PortersWizard } from "./facchini/wizard";
import { StorageWizard } from "./deposito/wizard";

export type BookingHubProps = {
  /** The service of the URL the page was loaded from: only its wizard gets ?passo= and the prefill. */
  initial: BookingService;
  initialStep: string | null;
  session: WizardSession;
  transport: BookingOptions;
  porters: PortersOptions;
  portersPrefill: PortersPrefill;
  storage: StorageOptions;
  storagePrefill: StoragePrefill;
};

/**
 * The three booking wizards behind one set of tabs. The server loads the options of all three at once, so a tab
 * switch is instant: the URL changes with history.pushState (Next keeps usePathname in sync, back/forward work)
 * and only the chosen wizard is mounted; it slides in from the side of the chosen tab (globals.css). Each wizard restores its own data from localStorage (D78), so a switch
 * back keeps what was typed; it restarts from the first step.
 */
export function BookingHub(props: BookingHubProps) {
  const pathname = usePathname();
  const active =
    BOOKING_TABS.find((t) => t.href === pathname)?.key ?? props.initial;
  const tab = bookingTab(active);
  const fromUrl = active === props.initial;

  // Slide direction of the next wizard: from the side of the chosen tab.
  const order = (key: BookingService) =>
    BOOKING_TABS.findIndex((t) => t.key === key);
  const [direction, setDirection] = useState<"left" | "right" | null>(null);
  const [shown, setShown] = useState(active);
  if (shown !== active) {
    // also covers back/forward, which change the pathname without select()
    setShown(active);
    setDirection(order(active) > order(shown) ? "right" : "left");
  }

  function select(next: BookingService) {
    if (next === active) return;
    const target = bookingTab(next);
    window.history.pushState(null, "", target.href);
    document.title = target.title;
  }

  let content: ReactNode;
  if (active === "trasporto") {
    content = props.transport.available ? (
      <Wizard
        options={props.transport}
        session={props.session}
        initialStep={fromUrl ? props.initialStep : null}
      />
    ) : (
      <Unavailable>
        Le prenotazioni online non sono disponibili in questo momento. Riprova
        più tardi.
      </Unavailable>
    );
  } else if (active === "facchinaggio") {
    content = props.porters ? (
      <PortersWizard
        options={props.porters}
        session={props.session}
        initialStep={fromUrl ? props.initialStep : null}
        prefill={fromUrl ? props.portersPrefill : {}}
      />
    ) : (
      <Unavailable>
        Il facchinaggio non è prenotabile online in questo momento.{" "}
        <a href="/contatti" className="underline">
          Contattaci
        </a>
        : ti aiutiamo noi.
      </Unavailable>
    );
  } else {
    content = props.storage.available ? (
      <StorageWizard
        options={props.storage}
        session={props.session}
        initialStep={fromUrl ? props.initialStep : null}
        prefill={fromUrl ? props.storagePrefill : {}}
      />
    ) : (
      <Unavailable>
        Il deposito non è prenotabile online in questo momento.{" "}
        <a href="/contatti" className="underline">
          Contattaci
        </a>
        : ti aiutiamo noi.
      </Unavailable>
    );
  }

  return (
    <>
      <BookingServiceTabs active={active} onSelect={select} />
      <h1 className="text-2xl font-semibold text-zinc-900">{tab.heading}</h1>
      {/* key: a fresh wizard per service (each restores its own state after mount) */}
      {/* overflow-x-clip: the slide must not add a horizontal scrollbar on phones (clip keeps sticky working) */}
      <div className="-mx-4 overflow-x-clip px-4">
        <div
          key={active}
          className={
            direction === "right"
              ? "motion-safe:animate-wizard-from-right"
              : direction === "left"
                ? "motion-safe:animate-wizard-from-left"
                : undefined
          }
        >
          {content}
        </div>
      </div>
    </>
  );
}

function Unavailable({ children }: { children: ReactNode }) {
  return (
    <p className="mt-6 rounded-md bg-amber-50 p-4 text-sm text-amber-900">
      {children}
    </p>
  );
}
