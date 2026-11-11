import { describe, expect, it } from "vitest";
import { PHOTOS_MAX_PER_STEP, type NextAction } from "./execution";
import {
  appleMapsUrl, googleMapsUrl, inkLength, isSignatureEnough, photoQueue, photosLeft, stepButtonState, telHref, type PendingPhoto,
} from "./execution-ui";

const step = (s: Partial<Extract<NextAction, { kind: "step" }>> = {}): NextAction => ({
  kind: "step", legIndex: 0, step: "loaded", label: "Carico completato", photoKind: "pickup", notBefore: null, ...s,
});

describe("navigation links", () => {
  it("Google Maps, Apple Maps, tel:", () => {
    expect(googleMapsUrl(45.4642, 9.19)).toBe("https://www.google.com/maps/dir/?api=1&destination=45.4642,9.19&travelmode=driving");
    expect(appleMapsUrl(45.4642, 9.19)).toBe("https://maps.apple.com/?daddr=45.4642,9.19&dirflg=d");
    expect(telHref("+39 333 123-4567")).toBe("tel:+393331234567");
  });
});

describe("photo queue", () => {
  it("add → ticket → progress → uploaded → registered (removed)", () => {
    let q = photoQueue([], { type: "add", localId: "a", legIndex: 0, kind: "pickup" });
    expect(q[0]).toMatchObject({ phase: "preparing", path: null });
    q = photoQueue(q, { type: "ticket", localId: "a", path: "o/1.jpg" });
    q = photoQueue(q, { type: "progress", localId: "a", progress: 140 });
    expect(q[0]).toMatchObject({ phase: "uploading", progress: 100 });
    q = photoQueue(q, { type: "uploaded", localId: "a" });
    expect(q[0].phase).toBe("registering");
    expect(photoQueue(q, { type: "registered", localId: "a" })).toEqual([]);
  });

  it("a failed photo stays with its path for «Riprova»; discard removes it", () => {
    let q: PendingPhoto[] = photoQueue([], { type: "add", localId: "a", legIndex: 0, kind: "pickup" });
    q = photoQueue(q, { type: "ticket", localId: "a", path: "o/1.jpg" });
    q = photoQueue(q, { type: "failed", localId: "a", error: "Connessione assente" });
    expect(q[0]).toMatchObject({ phase: "error", path: "o/1.jpg", error: "Connessione assente" });
    q = photoQueue(q, { type: "retry", localId: "a" });
    expect(q[0]).toMatchObject({ phase: "preparing", path: "o/1.jpg", error: null });
    expect(photoQueue(q, { type: "discard", localId: "a" })).toEqual([]);
  });

  it("room for photos", () => {
    expect(photosLeft(3, 2)).toBe(PHOTOS_MAX_PER_STEP - 5);
    expect(photosLeft(10, 1)).toBe(0);
  });
});

describe("big button", () => {
  const pending = (phase: PendingPhoto["phase"], legIndex = 0, kind: PendingPhoto["kind"] = "pickup"): PendingPhoto =>
    ({ localId: "x", legIndex, kind, path: null, phase, progress: 0, error: null });

  it("hidden when nothing runs; disabled while sending", () => {
    expect(stepButtonState({ next: { kind: "none" }, savedPhotos: 0, pending: [], submitting: false })).toEqual({ kind: "hidden" });
    expect(stepButtonState({ next: step({ step: "departed", photoKind: null }), savedPhotos: 0, pending: [], submitting: true }).kind).toBe("disabled");
  });

  it("one tap for steps without photos; in-app confirmation for «Carico/Scarico completato»", () => {
    expect(stepButtonState({ next: step({ step: "arrived_pickup", photoKind: null }), savedPhotos: 0, pending: [], submitting: false }))
      .toEqual({ kind: "ready", confirm: false });
    expect(stepButtonState({ next: step(), savedPhotos: 1, pending: [], submitting: false })).toEqual({ kind: "ready", confirm: true });
    expect(stepButtonState({ next: step({ step: "unloaded", photoKind: "delivery" }), savedPhotos: 1, pending: [], submitting: false }))
      .toEqual({ kind: "ready", confirm: true });
  });

  it("photos: missing, uploading, failed — only photos of THIS leg and kind count", () => {
    expect(stepButtonState({ next: step(), savedPhotos: 0, pending: [], submitting: false })).toEqual({ kind: "disabled", reason: "Aggiungi almeno una foto." });
    expect(stepButtonState({ next: step(), savedPhotos: 1, pending: [pending("uploading")], submitting: false }).kind).toBe("disabled");
    expect(stepButtonState({ next: step(), savedPhotos: 1, pending: [pending("error")], submitting: false })).toMatchObject({ kind: "disabled", reason: expect.stringContaining("Riprova") });
    expect(stepButtonState({ next: step(), savedPhotos: 1, pending: [pending("uploading", 1), pending("error", 0, "delivery")], submitting: false }).kind).toBe("ready");
  });

  it("before the pickup day: the reason from nextAction", () => {
    expect(stepButtonState({ next: step({ step: "arrived_pickup", photoKind: null, notBefore: "Potrai iniziare da lunedì 16 novembre." }), savedPhotos: 0, pending: [], submitting: false }))
      .toEqual({ kind: "disabled", reason: "Potrai iniziare da lunedì 16 novembre." });
  });

  it("POD: ready (the delivery screen confirms)", () => {
    expect(stepButtonState({ next: { kind: "pod" }, savedPhotos: 0, pending: [], submitting: false })).toEqual({ kind: "ready", confirm: false });
  });
});

describe("signature", () => {
  it("a dot or a tiny tick is not a signature", () => {
    expect(isSignatureEnough([])).toBe(false);
    expect(isSignatureEnough([[{ x: 10, y: 10 }]])).toBe(false);
    expect(isSignatureEnough([[{ x: 0, y: 0 }, { x: 10, y: 0 }]])).toBe(false);
    expect(inkLength([[{ x: 0, y: 0 }, { x: 30, y: 40 }], [{ x: 0, y: 0 }, { x: 0, y: 10 }]])).toBe(60);
    expect(isSignatureEnough([[{ x: 0, y: 0 }, { x: 30, y: 40 }]])).toBe(true);
  });
});
