"use server";

import type { ContactFormState } from "@/lib/contact/form";
import { submitContactForm } from "@/lib/contact/submit-form";

// Public contact form (D125). The checks and their order live in submitContactForm(); actions.test.ts checks
// that bots and invalid input never reach the service role.
export async function sendContactAction(_prev: ContactFormState, fd: FormData): Promise<ContactFormState> {
  return submitContactForm(fd);
}
