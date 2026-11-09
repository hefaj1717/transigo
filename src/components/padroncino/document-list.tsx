import { documentKey, documentStatus, romeToday, type CarrierDocumentRow } from "@/lib/carriers/documents";
import { uploadableDocumentTypes } from "@/lib/carriers/document-types";
import { DocumentUpload } from "./document-upload";

const TONE = { ok: "text-green-800", wait: "text-amber-900", bad: "text-red-700" } as const;

// One card per document type of the scope (D97, D98): newest upload, its status, a link to open it and,
// when the account state allows it (D112), the upload form.
export function DocumentList({
  scope, carrierId, vehicleId, latest, urls, editable,
}: {
  scope: "carrier" | "vehicle";
  carrierId: string;
  vehicleId: string | null;
  latest: Map<string, CarrierDocumentRow>;
  urls: Map<string, string>;
  editable: boolean;
}) {
  const today = romeToday();
  return (
    <ul className="space-y-4">
      {uploadableDocumentTypes(scope).map((t) => {
        const current = latest.get(documentKey(t.docType, vehicleId));
        const status = current ? documentStatus(current, today) : null;
        const url = current ? urls.get(current.id) : undefined;
        return (
          <li key={t.docType} id={t.docType} className="scroll-mt-20 rounded-xl border border-zinc-200 bg-white p-4">
            <h3 className="font-semibold text-zinc-900">
              {t.labelIt}
              {t.isRequired ? null : <span className="ml-2 text-xs font-normal text-zinc-500">facoltativo</span>}
            </h3>
            {current && status ? (
              <div className="mt-1 text-sm">
                <p className={TONE[status.tone]}>{status.label}</p>
                <p className="mt-1 truncate text-zinc-600">
                  {url ? (
                    <a href={url} target="_blank" rel="noopener noreferrer" className="font-medium text-[#0B3B8C] underline">
                      {current.mime_type === "image/heic" ? "Scarica" : "Apri"} {current.file_name}
                    </a>
                  ) : current.file_name}
                </p>
              </div>
            ) : (
              <p className="mt-1 text-sm text-zinc-600">Non ancora caricato.</p>
            )}
            {editable ? (
              <DocumentUpload carrierId={carrierId} docType={t.docType} vehicleId={vehicleId} expiryLabel={t.expiryLabelIt} hasCurrent={!!current} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
