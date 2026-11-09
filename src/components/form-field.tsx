import type { ReactNode } from "react";

type TextFieldProps = {
  label: string;
  name: string;
  type?: "text" | "email" | "password" | "tel";
  defaultValue?: string;
  error?: string;
  hint?: ReactNode;
  autoComplete?: string;
  required?: boolean;
  maxLength?: number;
  className?: string;
  placeholder?: string;
  inputMode?: "text" | "numeric" | "decimal" | "email" | "tel";
  /** Unit shown inside the field on the right, always visible (e.g. "kg", "cm"). */
  suffix?: string;
  readOnly?: boolean;
};

export function TextField({
  label, name, type = "text", defaultValue, error, hint, autoComplete, required, maxLength, className, placeholder, inputMode, suffix, readOnly,
}: TextFieldProps) {
  const id = `f-${name}`;
  const describedBy = [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-sm font-medium text-zinc-800">
        {label}
        {required ? <span className="text-red-600"> *</span> : null}
      </label>
      <div className="relative mt-1">
        <input
          id={id}
          name={name}
          type={type}
          defaultValue={defaultValue}
          autoComplete={autoComplete}
          maxLength={maxLength}
          placeholder={placeholder}
          inputMode={inputMode}
          readOnly={readOnly}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={`block w-full rounded-md border px-3 py-2 text-zinc-900 outline-none focus:ring-2 focus:ring-blue-500 ${
            error ? "border-red-500" : "border-zinc-300"
          } ${suffix ? "pr-12" : ""} ${readOnly ? "bg-zinc-100 text-zinc-600" : ""}`}
        />
        {suffix ? (
          <span aria-hidden className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-zinc-500">{suffix}</span>
        ) : null}
      </div>
      {hint ? <p id={`${id}-hint`} className="mt-1 text-xs text-zinc-500">{hint}</p> : null}
      {error ? <p id={`${id}-error`} className="mt-1 text-sm text-red-600">{error}</p> : null}
    </div>
  );
}

export function CheckboxField({ name, label, error, defaultChecked }: { name: string; label: ReactNode; error?: string; defaultChecked?: boolean }) {
  const id = `f-${name}`;
  return (
    <div>
      <div className="flex items-start gap-2">
        <input
          id={id}
          name={name}
          type="checkbox"
          defaultChecked={defaultChecked}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className="mt-1 h-4 w-4"
        />
        <label htmlFor={id} className="text-sm text-zinc-800">{label}</label>
      </div>
      {error ? <p id={`${id}-error`} className="mt-1 text-sm text-red-600">{error}</p> : null}
    </div>
  );
}

export function FormMessage({ error, success }: { error?: string; success?: string }) {
  if (error) {
    return <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>;
  }
  if (success) {
    return <p role="status" className="rounded-md bg-green-50 p-3 text-sm text-green-800">{success}</p>;
  }
  return null;
}

export function SelectField({
  label, name, options, defaultValue, error, hint, required, placeholder,
}: {
  label: string;
  name: string;
  options: { value: string; label: string }[];
  defaultValue?: string;
  error?: string;
  hint?: ReactNode;
  required?: boolean;
  placeholder?: string;
}) {
  const id = `f-${name}`;
  const describedBy = [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-zinc-800">
        {label}
        {required ? <span className="text-red-600"> *</span> : null}
      </label>
      <select
        id={id}
        name={name}
        defaultValue={defaultValue ?? ""}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`mt-1 block w-full rounded-md border bg-white px-3 py-2 text-zinc-900 outline-none focus:ring-2 focus:ring-blue-500 ${
          error ? "border-red-500" : "border-zinc-300"
        }`}
      >
        {placeholder ? <option value="" disabled>{placeholder}</option> : null}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {hint ? <p id={`${id}-hint`} className="mt-1 text-xs text-zinc-500">{hint}</p> : null}
      {error ? <p id={`${id}-error`} className="mt-1 text-sm text-red-600">{error}</p> : null}
    </div>
  );
}
