import { forwardRef } from "react";

type Variant = "primary" | "secondary" | "ghost" | "yes" | "no";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand text-white hover:bg-brand-strong active:scale-[0.99]",
  secondary:
    "bg-surface-2 text-foreground border border-border hover:bg-surface active:scale-[0.99]",
  ghost: "bg-transparent text-muted hover:text-foreground",
  yes: "bg-yes/15 text-yes border border-yes/40 hover:bg-yes/25 active:scale-[0.99]",
  no: "bg-no/15 text-no border border-no/40 hover:bg-no/25 active:scale-[0.99]",
};

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  loading?: boolean;
  fullWidth?: boolean;
}

/** Chunky, touch-friendly button. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { variant = "primary", loading, fullWidth = true, className = "", children, disabled, ...props },
    ref,
  ) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={[
        "inline-flex items-center justify-center gap-2 rounded-2xl px-5 py-3.5 text-base font-semibold transition",
        "disabled:opacity-50 disabled:pointer-events-none",
        fullWidth ? "w-full" : "",
        VARIANTS[variant],
        className,
      ].join(" ")}
      {...props}
    >
      {loading && (
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      {children}
    </button>
  ),
);
Button.displayName = "Button";
