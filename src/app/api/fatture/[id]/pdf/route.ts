import { NextResponse } from "next/server";
import { getAccountContext } from "@/lib/auth/session";
import { canDownload, PDF_URL_SECONDS, pdfFileName, type DocRow } from "@/lib/einvoice/view";
import { createClient } from "@/lib/supabase/server";

// "Scarica PDF" (D148): a signed URL valid 60 s, created with the reader's OWN session at the click — never while a
// list renders. RLS decides: the customer reads its own issued documents (table + bucket), the admin all; the carrier
// and other customers get 404. No service role here.

const noStore = { "Cache-Control": "no-store" };

export async function GET(request: Request, ctx: RouteContext<"/api/fatture/[id]/pdf">) {
  const { id } = await ctx.params;
  const account = await getAccountContext();
  if (account.state !== "signed_in" || account.isBlocked) {
    const login = new URL("/accedi", request.url);
    return NextResponse.redirect(login, { status: 303, headers: noStore });
  }
  if (!/^[0-9a-f-]{36}$/i.test(id) || (account.role !== "cliente" && account.role !== "admin")) {
    return new NextResponse("Not found", { status: 404, headers: noStore });
  }

  const supabase = await createClient();
  const { data: doc } = await supabase.from("invoices").select("kind, number, status, pdf_path").eq("id", id).maybeSingle<Pick<DocRow, "kind" | "number" | "status" | "pdf_path">>();
  if (!doc || !canDownload(doc)) return new NextResponse("Not found", { status: 404, headers: noStore });

  const { data, error } = await supabase.storage.from("invoices").createSignedUrl(doc.pdf_path!, PDF_URL_SECONDS, { download: pdfFileName(doc) });
  if (error || !data?.signedUrl) {
    console.error("[invoices] signed URL:", { invoiceId: id, error: error?.message });
    return new NextResponse("Not found", { status: 404, headers: noStore });
  }
  return NextResponse.redirect(data.signedUrl, { status: 303, headers: noStore });
}
