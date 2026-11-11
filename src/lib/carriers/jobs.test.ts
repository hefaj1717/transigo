import { afterEach, describe, expect, it } from "vitest";
import {
  acceptOutcome,
  describeJobBlockers,
  floorLabel,
  formatDuration,
  formatKm,
  JOB_MSG,
  jobDbError,
  jobListNotice,
  jobListNoticeKey,
  countMyJobs,
  jobsForTab,
  MY_JOB_TAB_EMPTY,
  MY_JOB_TABS,
  myJobsHref,
  myJobsNotice,
  myJobTab,
  overlappingJobs,
  parseMyJobTab,
  RELEASE_EXPIRED_TEXT,
  releaseDeadlineLabel,
  releaseDeadline,
  releaseInfo,
  romeDateTime,
  romeTime,
  romeWindow,
  routeLabel,
  toJobCard,
  type AvailableJobLeg,
  type AvailableJobRow,
} from "./jobs";

const leg = (over: Partial<AvailableJobLeg> = {}): AvailableJobLeg => ({
  leg_index: 0,
  pickup_city: "Milano",
  pickup_province: "MI",
  pickup_is_warehouse: false,
  delivery_city: "Roma",
  delivery_province: "RM",
  delivery_is_warehouse: false,
  distance_m: 573_400,
  duration_s: 19_800,
  pickup_date: "2026-11-12",
  pickup_window_start: "2026-11-12T07:00:00Z", // 08:00 Rome (CET)
  pickup_window_end: "2026-11-12T09:00:00Z",
  pickup_floor: 3,
  pickup_has_elevator: false,
  delivery_floor: 0,
  delivery_has_elevator: null,
  is_urgent: false,
  porter_package_code: null,
  porters_count: null,
  porters_included_hours: null,
  carrier_amount_cents: 42_000,
  ...over,
});

const row = (over: Partial<AvailableJobRow> = {}): AvailableJobRow => ({
  order_id: "o1",
  order_number: "TG-0001",
  vehicle_type_name: "Furgone medio",
  pickup_window_start: "2026-11-12T07:00:00Z",
  weight_kg: 800,
  largest_item_length_cm: 200,
  largest_item_width_cm: 90,
  largest_item_height_cm: 80,
  pallets_count: null,
  items_count: 12,
  load_category: null,
  packing_items_count: null,
  storage_type: null,
  storage_days: null,
  carrier_amount_cents: 42_000,
  transport_carrier_cents: 42_000,
  porters_carrier_cents: 0,
  packing_carrier_cents: 0,
  legs: [leg()],
  matching_vehicle_ids: ["v1"],
  ...over,
});

describe("times are always Europe/Rome, whatever the server's time zone", () => {
  const original = process.env.TZ;
  afterEach(() => {
    process.env.TZ = original;
  });

  it.each(["UTC", "America/New_York", "Asia/Tokyo", "Europe/Rome"])("server TZ %s", (tz) => {
    process.env.TZ = tz;
    // winter (CET, UTC+1)
    expect(romeTime("2026-11-12T07:00:00Z")).toBe("08:00");
    expect(romeWindow("2026-11-12T07:00:00Z", "2026-11-12T09:00:00Z")).toBe("giovedì 12 novembre, 08:00–10:00");
    // summer (CEST, UTC+2)
    expect(romeTime("2026-07-01T06:00:00Z")).toBe("08:00");
    // after midnight in Rome but still the day before in UTC
    expect(romeDateTime("2026-11-10T23:30:00Z")).toBe("11 novembre alle 00:30");
  });

  it("the Rinuncia deadline label is in Rome time", () => {
    process.env.TZ = "America/Los_Angeles";
    const info = releaseInfo(
      { status: "assigned", assigned_at: "2026-11-09T10:00:00Z", pickup_window_start: "2026-11-14T07:00:00Z" },
      new Date("2026-11-09T12:00:00Z"),
    );
    expect(info.allowed && info.label).toBe("Puoi rinunciare fino alle 08:00 di giovedì 12 novembre.");
  });
});

describe("releaseInfo / releaseDeadline — display only, same rule as release_job (D121)", () => {
  const assigned = "2026-11-09T10:00:00.000Z";
  const at = (iso: string) => new Date(iso);

  describe("15 minutes after accepting (pickup soon)", () => {
    const o = { status: "assigned", assigned_at: assigned, pickup_window_start: "2026-11-10T07:00:00Z" };
    it("exactly 15 min after accepting → still allowed (inclusive, as `now <= assigned_at + 15 min`)", () => {
      expect(releaseInfo(o, at("2026-11-09T10:15:00.000Z")).allowed).toBe(true);
    });
    it("1 ms later → expired", () => {
      expect(releaseInfo(o, at("2026-11-09T10:15:00.001Z"))).toMatchObject({ allowed: false, reason: "expired" });
    });
    it("deadline = assigned_at + 15 min", () => {
      expect(releaseDeadline(assigned, o.pickup_window_start).toISOString()).toBe("2026-11-09T10:15:00.000Z");
    });
  });

  describe("48 hours before the pickup window", () => {
    const o = { status: "assigned", assigned_at: assigned, pickup_window_start: "2026-11-14T07:00:00.000Z" };
    it("exactly 48 h before → still allowed (inclusive, as `pickup_window_start >= now + 48 h`)", () => {
      expect(releaseInfo(o, at("2026-11-12T07:00:00.000Z")).allowed).toBe(true);
    });
    it("1 ms later → expired", () => {
      expect(releaseInfo(o, at("2026-11-12T07:00:00.001Z"))).toMatchObject({ allowed: false, reason: "expired" });
    });
    it("deadline = pickup − 48 h when that is later than the 15 minutes", () => {
      expect(releaseDeadline(assigned, o.pickup_window_start).toISOString()).toBe("2026-11-12T07:00:00.000Z");
    });
  });

  it("only status assigned; picked up or in transit → not by the carrier", () => {
    const base = { assigned_at: assigned, pickup_window_start: "2026-11-20T07:00:00Z" };
    for (const status of ["picked_up", "in_transit", "delivered", "paid"]) {
      expect(releaseInfo({ ...base, status }, at(assigned))).toEqual({ allowed: false, reason: "status", deadline: null });
    }
    expect(releaseInfo({ ...base, status: "assigned", assigned_at: null }, at(assigned)).allowed).toBe(false);
  });
});

describe("accept_job result", () => {
  it("newly assigned → accepted", () => {
    expect(acceptOutcome([{ assigned_at: "2026-11-09T10:00:00Z", newly_assigned: true }])).toEqual({ ok: true, newlyAssigned: true, message: JOB_MSG.accepted });
  });
  it("the same carrier again (double click) → 'already yours', never 'taken by another carrier'", () => {
    const r = acceptOutcome([{ assigned_at: "2026-11-09T10:00:00Z", newly_assigned: false }]);
    expect(r).toEqual({ ok: true, newlyAssigned: false, message: JOB_MSG.alreadyMine });
    expect(r.message).not.toBe(JOB_MSG.alreadyTaken);
  });
  it("a single object works too; an unexpected shape is an error", () => {
    expect(acceptOutcome({ newly_assigned: true }).ok).toBe(true);
    expect(acceptOutcome([]).ok).toBe(false);
    expect(acceptOutcome(null).ok).toBe(false);
  });
});

describe("jobDbError", () => {
  const e = (code: string, details: string) => ({ code, message: "x", details });
  it("already_taken → D120 text and refresh the list", () => {
    expect(jobDbError("accept", e("55000", "already_taken"))).toEqual({ message: "Questa corsa è già stata accettata da un altro padroncino.", refreshList: true });
  });
  it("not_available and too_late on accept refresh the list", () => {
    expect(jobDbError("accept", e("55000", "not_available"))).toEqual({ message: JOB_MSG.notAvailable, refreshList: true });
    expect(jobDbError("accept", e("55000", "too_late"))).toEqual({ message: JOB_MSG.acceptTooLate, refreshList: true });
  });
  it("too_late on release → contact Transigo", () => {
    expect(jobDbError("release", e("55000", "too_late"))).toEqual({ message: JOB_MSG.releaseTooLate, refreshList: false });
    expect(jobDbError("release", e("55000", "not_assigned")).message).toBe(JOB_MSG.notAssigned);
    expect(jobDbError("release", e("55000", "loaded"))).toEqual({ message: "Il carico è già a bordo. Contatta Transigo.", refreshList: false });
  });
  it("vehicle errors keep the carrier on the job", () => {
    expect(jobDbError("accept", e("55000", "vehicle_not_suitable"))).toEqual({ message: JOB_MSG.vehicleNotSuitable, refreshList: false });
    expect(jobDbError("accept", e("55000", "vehicle_not_ready")).message).toBe(JOB_MSG.vehicleNotReady);
    expect(jobDbError("accept", e("22023", "vehicle")).message).toBe(JOB_MSG.chooseVehicle);
    expect(jobDbError("accept", e("22023", "order"))).toEqual({ message: JOB_MSG.notFound, refreshList: true });
  });
  it("42501: inactive account, documents, not a carrier", () => {
    expect(jobDbError("accept", e("42501", "carrier_not_active")).message).toBe(JOB_MSG.notEligible);
    expect(jobDbError("accept", e("42501", "document:driving_license")).message).toBe(JOB_MSG.documents);
    expect(jobDbError("accept", e("42501", "not_carrier")).message).toBe(JOB_MSG.forbidden);
  });
  it("anything else → generic", () => {
    expect(jobDbError("accept", { code: "XX000", message: "boom" }).message).toBe(JOB_MSG.generic);
    expect(jobDbError("release", null).message).toBe(JOB_MSG.generic);
  });
});

describe("describeJobBlockers", () => {
  it("nothing blocking and a ready vehicle → empty", () => {
    expect(describeJobBlockers([], 1)).toEqual([]);
  });
  it("inactive account: one message, no vehicle hint", () => {
    expect(describeJobBlockers(["carrier_not_active"], 0).map((b) => b.code)).toEqual(["carrier_not_active"]);
  });
  it("documents link to their section; no ready vehicle links to the vehicles", () => {
    const b = describeJobBlockers(["document:driving_license"], 0);
    expect(b[0]).toMatchObject({ href: "/padroncino/documenti#driving_license" });
    expect(b[0].label).toContain("Patente del titolare");
    expect(b[1]).toMatchObject({ code: "no_ready_vehicle", href: "/padroncino/veicoli" });
  });
});

describe("toJobCard", () => {
  it("amounts stay in cents; route, km, time, load", () => {
    const c = toJobCard(row());
    expect(c.amount).toEqual({ totalCents: 42_000, transportCents: 42_000, portersCents: 0, packingCents: 0 });
    expect(routeLabel(c.stops)).toBe("Milano (MI) → Roma (RM)");
    expect(formatKm(c.distanceM)).toBe("573 km");
    expect(formatDuration(c.durationS)).toBe("5 h 30 min");
    expect(c.load).toEqual(["800 kg", "Oggetto più grande 200 × 90 × 80 cm", "12 colli"]);
    expect(c.legs[0].pickupFloor).toBe("3° piano, senza ascensore");
    expect(c.legs[0].deliveryFloor).toBe("Piano terra");
    expect(c.isUrgent).toBe(false);
  });

  it("storage order: warehouse once in the route, both legs summed, urgent if any leg is", () => {
    const c = toJobCard(row({
      storage_type: "short_term",
      storage_days: 5,
      porters_carrier_cents: 9_000,
      legs: [
        leg({ leg_index: 1, pickup_city: "Bologna", pickup_province: "BO", pickup_is_warehouse: true, distance_m: 380_000, duration_s: 12_600, is_urgent: true }),
        leg({ delivery_city: "Bologna", delivery_province: "BO", delivery_is_warehouse: true, distance_m: 215_000, duration_s: 7_800, porters_count: 2, porter_package_code: "bilocale", porters_included_hours: 3 }),
      ],
    }));
    expect(routeLabel(c.stops)).toBe("Milano (MI) → Magazzino Bologna (BO) → Roma (RM)");
    expect(c.distanceM).toBe(595_000);
    expect(c.isUrgent).toBe(true);
    expect(c.services).toEqual(["Tratta 1: 2 facchini (Bilocale), 3 h incluse", "Deposito a breve termine, 5 giorni"]);
    expect(c.pickupWindowStart).toBe("2026-11-12T07:00:00Z");
  });
});

describe("formatting helpers", () => {
  it("km and duration", () => {
    expect(formatKm(7_449)).toBe("7,4 km");
    // it-IT (CLDR) groups thousands only from 5 digits
    expect(formatKm(1_234_000)).toBe("1234 km");
    expect(formatKm(12_345_000)).toBe("12.345 km");
    expect(formatDuration(2_700)).toBe("45 min");
    expect(formatDuration(7_200)).toBe("2 h");
    expect(formatDuration(10)).toBe("1 min");
  });
  it("floors", () => {
    expect(floorLabel(null, true)).toBeNull();
    expect(floorLabel(2, true)).toBe("2° piano, con ascensore");
    expect(floorLabel(-1, null)).toBe("Piano -1");
  });
});

describe("overlappingJobs (D120: warning only)", () => {
  const busy = (start: string, end: string, durationS = 3_600) => ({ pickupWindowStart: start, pickupWindowEnd: end, durationS });
  const candidate = { orderId: "new", legs: [busy("2026-11-12T07:00:00Z", "2026-11-12T09:00:00Z")] }; // busy 07:00–10:00 UTC

  it("overlap with an assigned or ongoing job; not with finished ones or itself", () => {
    const mine = [
      { orderId: "a", orderNumber: "TG-A", status: "assigned", legs: [busy("2026-11-12T09:30:00Z", "2026-11-12T11:30:00Z")] },
      { orderId: "b", orderNumber: "TG-B", status: "delivered", legs: [busy("2026-11-12T07:00:00Z", "2026-11-12T09:00:00Z")] },
      { orderId: "new", orderNumber: "TG-N", status: "assigned", legs: candidate.legs },
      { orderId: "c", orderNumber: "TG-C", status: "in_transit", legs: [busy("2026-11-12T05:00:00Z", "2026-11-12T06:00:00Z", 3_600)] },
    ];
    expect(overlappingJobs(candidate, mine)).toEqual([{ orderId: "a", orderNumber: "TG-A" }]);
  });
  it("touching ends do not count; the driving time extends the busy time", () => {
    const touching = [{ orderId: "t", orderNumber: "TG-T", status: "assigned", legs: [busy("2026-11-12T10:00:00Z", "2026-11-12T12:00:00Z")] }];
    expect(overlappingJobs(candidate, touching)).toEqual([]);
    const longDrive = [{ orderId: "l", orderNumber: "TG-L", status: "assigned", legs: [busy("2026-11-12T04:00:00Z", "2026-11-12T06:00:00Z", 5 * 3_600)] }];
    expect(overlappingJobs(candidate, longDrive)).toEqual([{ orderId: "l", orderNumber: "TG-L" }]);
  });
});

describe("myJobTab", () => {
  it("Da fare / In corso / Concluse; other statuses hidden", () => {
    expect(myJobTab("assigned")).toBe("da-fare");
    expect(myJobTab("picked_up")).toBe("in-corso");
    expect(myJobTab("in_transit")).toBe("in-corso");
    expect(myJobTab("delivered")).toBe("concluse");
    expect(myJobTab("completed")).toBe("concluse");
    expect(myJobTab("refunded")).toBeNull();
  });
});

describe("Le mie corse — tabs, counters, notices", () => {
  const j = (orderId: string, tab: "da-fare" | "in-corso" | "concluse", pickupWindowStart: string) => ({ orderId, tab, pickupWindowStart });
  const jobs = [
    j("a", "da-fare", "2026-11-12T07:00:00Z"),
    j("b", "concluse", "2026-11-01T07:00:00Z"),
    j("c", "da-fare", "2026-11-10T07:00:00Z"),
    j("d", "in-corso", "2026-11-09T07:00:00Z"),
    j("e", "concluse", "2026-11-05T07:00:00Z"),
  ];

  it("counts per tab (zero tabs included)", () => {
    expect(countMyJobs(jobs)).toEqual({ "da-fare": 2, "in-corso": 1, concluse: 2 });
    expect(countMyJobs([])).toEqual({ "da-fare": 0, "in-corso": 0, concluse: 0 });
  });

  it("Da fare / In corso: next pickup first; Concluse: most recent first", () => {
    expect(jobsForTab(jobs, "da-fare").map((x) => x.orderId)).toEqual(["c", "a"]);
    expect(jobsForTab(jobs, "in-corso").map((x) => x.orderId)).toEqual(["d"]);
    expect(jobsForTab(jobs, "concluse").map((x) => x.orderId)).toEqual(["e", "b"]);
    expect(jobs.map((x) => x.orderId)).toEqual(["a", "b", "c", "d", "e"]); // input untouched
  });

  it("?tab= accepts only the three keys, default Da fare", () => {
    expect(parseMyJobTab("in-corso")).toBe("in-corso");
    expect(parseMyJobTab("concluse")).toBe("concluse");
    for (const bad of [undefined, "", "tutte", ["in-corso"], "__proto__"]) expect(parseMyJobTab(bad)).toBe("da-fare");
  });

  it("every tab has an Italian empty state", () => {
    for (const t of MY_JOB_TABS) {
      expect(MY_JOB_TAB_EMPTY[t.key].title).toMatch(/^Nessuna corsa/);
      expect(MY_JOB_TAB_EMPTY[t.key].text.length).toBeGreaterThan(10);
    }
  });

  it("links: default tab without query; outcome notice by key only", () => {
    expect(myJobsHref()).toBe("/padroncino/le-mie-corse");
    expect(myJobsHref({ tab: "da-fare" })).toBe("/padroncino/le-mie-corse");
    expect(myJobsHref({ tab: "concluse" })).toBe("/padroncino/le-mie-corse?tab=concluse");
    expect(myJobsHref({ esito: "rinuncia" })).toBe("/padroncino/le-mie-corse?esito=rinuncia");
    expect(myJobsNotice("rinuncia")).toMatch(/torna disponibile per gli altri padroncini/);
    for (const bad of [undefined, "toString", "__proto__", "<script>", ["rinuncia"]]) expect(myJobsNotice(bad)).toBeNull();
  });
});

describe("Rinuncia texts", () => {
  const original = process.env.TZ;
  afterEach(() => {
    process.env.TZ = original;
  });
  it.each(["UTC", "Asia/Tokyo", "Europe/Rome"])("deadline label in Rome time (server TZ %s)", (tz) => {
    process.env.TZ = tz;
    expect(releaseDeadlineLabel("2026-11-10T23:30:00Z")).toBe("Puoi rinunciare fino alle 00:30 di mercoledì 11 novembre.");
    expect(releaseDeadlineLabel("2026-07-01T06:00:00Z")).toBe("Puoi rinunciare fino alle 08:00 di mercoledì 1 luglio.");
  });
  it("after the deadline: contact Transigo, same text as too_late", () => {
    expect(RELEASE_EXPIRED_TEXT).toMatch(/contatta subito Transigo/);
  });
});

describe("list notice after a failed accept (?avviso=)", () => {
  it("already_taken goes to the list as a key and comes back as the D120 text", () => {
    const view = jobDbError("accept", { code: "55000", details: "already_taken" });
    expect(view.refreshList).toBe(true);
    const key = jobListNoticeKey(view.message);
    expect(key).toBe("alreadyTaken");
    expect(jobListNotice(key)).toBe(JOB_MSG.alreadyTaken);
  });

  it("every refresh-list error of accept_job has a notice key", () => {
    const errors = [
      { code: "55000", details: "already_taken" },
      { code: "55000", details: "not_available" },
      { code: "55000", details: "too_late" },
      { code: "42501", details: "carrier_not_active" },
      { code: "42501", details: "document:visura" },
      { code: "22023", details: "order" },
    ];
    for (const e of errors) {
      const view = jobDbError("accept", e);
      expect(view.refreshList).toBe(true);
      expect(jobListNoticeKey(view.message)).not.toBeNull();
    }
  });

  it("ignores anything that is not a known key (no free text from the URL)", () => {
    expect(jobListNotice("<script>")).toBeNull();
    expect(jobListNotice("accepted")).toBeNull();
    expect(jobListNotice(["alreadyTaken"])).toBeNull();
    expect(jobListNotice(undefined)).toBeNull();
    expect(jobListNoticeKey("qualcosa")).toBeNull();
  });
});
