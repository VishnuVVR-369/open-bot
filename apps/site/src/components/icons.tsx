type IconProps = { className?: string };

export function PlayGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} fill="currentColor">
      <path d="M4 2.6v10.8a.9.9 0 0 0 1.36.77l8.9-5.4a.9.9 0 0 0 0-1.54l-8.9-5.4A.9.9 0 0 0 4 2.6Z" />
    </svg>
  );
}

export function GitHubMark({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/** The logo: a monitor with its tally light, and the stand. */
export function Logo({ className }: IconProps) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden className={className}>
      <rect width="64" height="64" rx="15" fill="#14161b" />
      <rect
        x="13"
        y="17"
        width="38"
        height="25"
        rx="4"
        fill="none"
        stroke="#f3f4f6"
        strokeWidth="4"
      />
      <circle cx="45" cy="23" r="3" fill="#e5484d" />
      <path d="M25 49h14" stroke="#f3f4f6" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}
