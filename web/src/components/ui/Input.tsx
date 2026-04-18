import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  leading?: ReactNode;
  trailing?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className = '', leading, trailing, ...props }, ref) => {
    const inputEl = (
      <input
        ref={ref}
        className={`block w-full rounded-btn border border-line-2 bg-white px-2.5 py-[6px] text-sm2 text-ink placeholder:text-ink-3 focus:border-brand focus:ring-2 focus:ring-brand/15 ${
          leading ? 'pl-7' : ''
        } ${trailing ? 'pr-7' : ''} ${className}`}
        {...props}
      />
    );
    if (!leading && !trailing) return inputEl;
    return (
      <div className="relative">
        {leading && (
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none">
            {leading}
          </span>
        )}
        {inputEl}
        {trailing && (
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none">
            {trailing}
          </span>
        )}
      </div>
    );
  }
);
Input.displayName = 'Input';
