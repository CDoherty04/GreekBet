/** A surface panel used to group content. */
export function Card({
  className = "",
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={[
        "rounded-2xl border border-border bg-surface p-4",
        className,
      ].join(" ")}
      {...props}
    >
      {children}
    </div>
  );
}
