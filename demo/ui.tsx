import {
  createContext,
  useContext,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type SelectHTMLAttributes,
} from "react";

type ClassValue = string | false | null | undefined;

function cn(...values: ClassValue[]) {
  return values.filter(Boolean).join(" ");
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  size?: "default" | "sm";
  variant?: "default" | "secondary" | "outline" | "ghost";
};

export function Button({ className, size = "default", variant = "default", ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex cursor-pointer items-center justify-center rounded-md border font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50",
        size === "sm" ? "min-h-8 px-3 text-sm" : "min-h-9 px-4 text-sm",
        variant === "default" && "border-[#0f766e] bg-[#0f766e] text-white hover:bg-[#115e59]",
        variant === "secondary" && "border-[#d8e0ea] bg-[#eef2f6] text-[#172233] hover:bg-[#e2e8f0]",
        variant === "outline" && "border-[#c9d3df] bg-white text-[#172233] hover:bg-[#f8fafc]",
        variant === "ghost" && "border-transparent bg-transparent text-[#172233] hover:bg-[#eef2f6]",
        className,
      )}
      {...props}
    />
  );
}

type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  variant?: "default" | "secondary" | "outline";
};

export function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold",
        variant === "default" && "border-[#0f766e] bg-[#0f766e] text-white",
        variant === "secondary" && "border-[#d8e0ea] bg-[#eef2f6] text-[#172233]",
        variant === "outline" && "border-[#c9d3df] bg-transparent text-[#172233]",
        className,
      )}
      {...props}
    />
  );
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("grid rounded-lg border border-[#c6d2de] bg-white p-5 shadow-sm", className)} {...props} />;
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("grid gap-1.5", className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("m-0 text-base font-bold text-[#101827]", className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("grid gap-3", className)} {...props} />;
}

type NativeSelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & {
  size?: "default" | "sm";
};

export function NativeSelect({ className, size = "default", ...props }: NativeSelectProps) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "rounded-md border border-[#c9d3df] bg-white text-[#172233] outline-none focus:border-[#0f766e]",
        size === "sm" ? "min-h-8 px-2 text-sm" : "min-h-9 px-3 text-sm",
        className,
      )}
      {...props}
    />
  );
}

type TabsContextValue = {
  onValueChange?: (value: string) => void;
  value: string;
};

const TabsContext = createContext<TabsContextValue | null>(null);

type TabsProps = HTMLAttributes<HTMLDivElement> & {
  onValueChange?: (value: string) => void;
  value: string;
};

export function Tabs({ value, onValueChange, ...props }: TabsProps) {
  return (
    <TabsContext.Provider value={{ value, onValueChange }}>
      <div {...props} />
    </TabsContext.Provider>
  );
}

export function TabsList({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div role="tablist" className={cn("flex gap-2", className)} {...props} />;
}

type TabsTriggerProps = ButtonHTMLAttributes<HTMLButtonElement> & { value: string };

export function TabsTrigger({ className, onClick, value, ...props }: TabsTriggerProps) {
  const context = useContext(TabsContext);
  if (!context) throw new Error("TabsTrigger must be rendered inside Tabs");
  const active = context.value === value;

  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-state={active ? "active" : "inactive"}
      className={cn(
        "min-h-9 rounded-md border px-3 text-sm font-semibold transition-colors",
        active
          ? "border-[#0f766e] bg-[#0f766e] text-white"
          : "border-[#c9d3df] bg-white text-[#172233] hover:bg-[#f8fafc]",
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) context.onValueChange?.(value);
      }}
      {...props}
    />
  );
}
