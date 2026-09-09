import { forwardRef } from "react";

interface TextFieldProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
}

/** Labeled text input tuned for mobile (large tap target, no zoom on focus). */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(
  ({ label, hint, className = "", id, ...props }, ref) => {
    const inputId = id ?? props.name;
    return (
      <label htmlFor={inputId} className="block">
        {label && (
          <span className="mb-1.5 block label-hud">
            {label}
          </span>
        )}
        <input
          ref={ref}
          id={inputId}
          className={[
            "w-full rounded-2xl border border-border bg-surface-2 px-4 py-3.5 text-base text-foreground",
            "placeholder:text-muted/60 outline-none focus:border-brand",
            className,
          ].join(" ")}
          {...props}
        />
        {hint && <span className="mt-1.5 block text-xs text-muted">{hint}</span>}
      </label>
    );
  },
);
TextField.displayName = "TextField";
