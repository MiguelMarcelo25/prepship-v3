import { forwardRef, type ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'outline' | 'ghost' | 'green' | 'danger';
type Size = 'xs' | 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const base =
  'inline-flex items-center justify-center gap-1.5 font-semibold rounded-btn transition-all duration-150 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed';

const variants: Record<Variant, string> = {
  primary:
    'bg-brand text-white hover:bg-brand-dark border border-transparent',
  outline:
    'bg-white text-ink-2 hover:text-ink hover:bg-surface-2 border border-line-2',
  ghost:
    'bg-transparent text-ink-2 hover:bg-surface-2 hover:text-ink border border-transparent hover:border-line',
  green:
    'bg-ok text-white hover:bg-ok-dark border border-transparent',
  danger:
    'bg-danger text-white hover:brightness-95 border border-transparent',
};

const sizes: Record<Size, string> = {
  xs: 'px-2 py-[3px] text-tiny',
  sm: 'px-2.5 py-[5px] text-[12px]',
  md: 'px-3 py-[6px] text-sm2',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'outline', size = 'md', className = '', ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';
