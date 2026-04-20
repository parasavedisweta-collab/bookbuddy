import { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "outline" | "ghost";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  fullWidth?: boolean;
}

const variantClasses: Record<Variant, string> = {
  primary:
    "bg-tactile-gradient text-white shadow-[0_8px_32px_rgba(65,112,0,0.15)] hover:scale-[0.97] active:scale-95",
  secondary:
    "bg-secondary-container text-on-secondary-container hover:scale-[0.97] active:scale-95",
  outline:
    "bg-white border-2 border-primary/20 text-primary hover:bg-primary-container/10 active:scale-95",
  ghost: "text-primary hover:bg-primary-container/10",
};

export default function Button({
  variant = "primary",
  fullWidth = false,
  className = "",
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={`
        font-headline font-bold text-lg py-4 px-6 rounded-xl
        transition-all flex items-center justify-center gap-2
        disabled:opacity-50 disabled:cursor-not-allowed
        ${variantClasses[variant]}
        ${fullWidth ? "w-full" : ""}
        ${className}
      `}
      {...props}
    >
      {children}
    </button>
  );
}
