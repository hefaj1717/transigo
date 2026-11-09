import "server-only";
import { getAppUrl } from "@/lib/supabase/env";
import { createServiceClient } from "@/lib/supabase/service";
import type { JobNotifyDeps } from "./jobs-server";

/**
 * Notification deps for acceptJob / releaseJob. The service-role client is NOT created here: `serviceDb` is a
 * factory that jobs-server.ts calls only after a successful accept_job / release_job (only for email_outbox).
 * Call it only after requireArea("padroncino").
 */
export function jobNotifyDeps(): JobNotifyDeps {
  return {
    serviceDb: () => createServiceClient(),
    adminEmail: process.env.ADMIN_NOTIFICATION_EMAIL?.trim() || null,
    appUrl: getAppUrl(),
  };
}
