/** Result of admin Server Actions, shown by <ActionForm>. */
export type ActionResult = { error?: string; message?: string; at?: number };
export const initialActionResult: ActionResult = {};
