import { InputHTMLAttributes } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export default function Input({ label, className = "", ...props }: InputProps) {
  return (
    <div className="space-y-2">
      {label && (
        <label className="block text-secondary-dim font-headline font-semibold text-sm ml-1">
          {label}
        </label>
      )}
      <input
        className={`
          w-full bg-surface-container-high border-none rounded-lg px-5 py-4
          font-body text-lg text-on-surface
          placeholder:text-outline-variant
          focus:ring-2 focus:ring-primary-container focus:bg-surface-container-lowest
          transition-all shadow-sm outline-none
          ${className}
        `}
        {...props}
      />
    </div>
  );
}
