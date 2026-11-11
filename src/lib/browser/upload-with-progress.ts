// Browser only. Upload to a Storage signed upload URL with progress (fetch has no upload progress → XHR PUT).
// Same request as supabase-js uploadToSignedUrl with a raw body. The answer is shaped like a Storage error
// ({ statusCode, message }) so uploadErrorMessage() maps it; no status at all = network problem.

export type UploadError = { statusCode?: string; message?: string } | null;

export function uploadWithProgress(signedUrl: string, body: Blob, contentType: string, onProgress: (percent: number) => void): Promise<UploadError> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", signedUrl);
    xhr.setRequestHeader("content-type", contentType);
    xhr.setRequestHeader("cache-control", "max-age=3600");
    xhr.setRequestHeader("x-upsert", "false");
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (key) xhr.setRequestHeader("apikey", key);
    xhr.timeout = 120_000;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress((e.loaded / e.total) * 100);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve(null);
      let parsed: { statusCode?: string | number; message?: string; error?: string } = {};
      try {
        parsed = JSON.parse(xhr.responseText);
      } catch {
        // not JSON (proxy page) — keep the HTTP status
      }
      resolve({ statusCode: String(parsed.statusCode ?? xhr.status), message: parsed.message ?? parsed.error ?? "" });
    };
    xhr.onerror = () => resolve({ message: "network error" });
    xhr.ontimeout = () => resolve({ message: "timeout" });
    xhr.send(body);
  });
}

/** One-time position for a step (owner 2026-11-11, pyt. 4): never blocks — null after 3 s, refusal or http. */
export function currentPosition(timeoutMs = 3000): Promise<{ lat: number; lng: number } | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation || !window.isSecureContext) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs + 200);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        clearTimeout(timer);
        resolve({ lat: p.coords.latitude, lng: p.coords.longitude });
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 120_000 },
    );
  });
}
