import * as React from "react"
import { cn } from "@/lib/utils"

/** Native keyboard and mobile picker behavior with the shared field treatment. */
const NativeSelect = React.forwardRef<HTMLSelectElement, React.ComponentProps<"select">>(
  ({ className, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        "h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 text-base font-normal text-foreground shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none sm:h-9 sm:text-sm",
        className,
      )}
      {...props}
    />
  ),
)
NativeSelect.displayName = "NativeSelect"
export { NativeSelect }
