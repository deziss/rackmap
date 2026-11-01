import { cn } from "../lib/utils";

interface RackMapLogoProps {
  size?: number | "sm" | "md" | "lg" | "xl";
  showText?: boolean;
  className?: string;
  textClassName?: string;
}

export function RackMapLogo({
  size = "md",
  showText = false,
  className,
  textClassName,
}: RackMapLogoProps) {
  const pixelSize =
    typeof size === "number"
      ? size
      : size === "sm"
      ? 24
      : size === "md"
      ? 32
      : size === "lg"
      ? 44
      : 56;

  return (
    <div className={cn("inline-flex items-center gap-2.5", className)}>
      <svg
        width={pixelSize}
        height={pixelSize}
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="shrink-0 transition-transform duration-200 group-hover:scale-105"
      >
        <defs>
          <linearGradient id="rm-logo-border" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#818CF8" />
            <stop offset="50%" stopColor="#6366F1" />
            <stop offset="100%" stopColor="#06B6D4" />
          </linearGradient>
          <linearGradient id="rm-logo-bg" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#1E1B4B" />
            <stop offset="60%" stopColor="#0F172A" />
            <stop offset="100%" stopColor="#020617" />
          </linearGradient>
          <linearGradient id="rm-logo-rack" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#312E81" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#1E1B4B" stopOpacity="0.4" />
          </linearGradient>
          <linearGradient id="rm-logo-curve" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#818CF8" />
            <stop offset="50%" stopColor="#6366F1" />
            <stop offset="100%" stopColor="#06B6D4" />
          </linearGradient>
          <linearGradient id="rm-logo-glow" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#06B6D4" />
            <stop offset="100%" stopColor="#818CF8" />
          </linearGradient>
          <filter id="rm-logo-filter" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
        </defs>

        {/* Chassis Background */}
        <rect x="2" y="2" width="60" height="60" rx="16" fill="url(#rm-logo-bg)" />
        <rect
          x="2"
          y="2"
          width="60"
          height="60"
          rx="16"
          stroke="url(#rm-logo-border)"
          strokeWidth="2"
          strokeOpacity="0.9"
        />

        {/* Vertical Rack Rail */}
        <rect x="11" y="14" width="3" height="36" rx="1.5" fill="#6366F1" fillOpacity="0.55" />

        {/* Rack Blade Unit 1 */}
        <rect
          x="16"
          y="14"
          width="18"
          height="7.5"
          rx="2"
          fill="url(#rm-logo-rack)"
          stroke="#4F46E5"
          strokeWidth="1"
        />
        <line x1="19" y1="17.75" x2="27" y2="17.75" stroke="#38BDF8" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="30.5" cy="17.75" r="1.3" fill="#10B981" />

        {/* Rack Blade Unit 2 */}
        <rect
          x="16"
          y="24"
          width="18"
          height="7.5"
          rx="2"
          fill="url(#rm-logo-rack)"
          stroke="#4F46E5"
          strokeWidth="1"
        />
        <line x1="19" y1="27.75" x2="25" y2="27.75" stroke="#818CF8" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="28" cy="27.75" r="1.3" fill="#38BDF8" />
        <circle cx="31" cy="27.75" r="1.3" fill="#6366F1" />

        {/* Rack Blade Unit 3 */}
        <rect
          x="16"
          y="34"
          width="18"
          height="7.5"
          rx="2"
          fill="url(#rm-logo-rack)"
          stroke="#4F46E5"
          strokeWidth="1"
        />
        <line x1="19" y1="37.75" x2="28" y2="37.75" stroke="#06B6D4" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="31" cy="37.75" r="1.3" fill="#10B981" />

        {/* Stylized R Upper Loop */}
        <path
          d="M 30 14 H 41 C 47 14 51 17.5 51 22.5 C 51 27.5 47 31 41 31 H 30"
          stroke="url(#rm-logo-curve)"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Stylized R Diagonal Leg */}
        <path
          d="M 39 30 L 49.5 47.5"
          stroke="url(#rm-logo-curve)"
          strokeWidth="3.8"
          strokeLinecap="round"
        />

        {/* Active Core Network Node */}
        <circle cx="39" cy="30.5" r="3" fill="#06B6D4" filter="url(#rm-logo-filter)" />
        <circle cx="39" cy="30.5" r="1.5" fill="#FFFFFF" />

        {/* Status Activity Bar */}
        <rect x="15" y="46" width="19" height="3" rx="1.5" fill="#1E293B" />
        <rect x="15" y="46" width="11" height="3" rx="1.5" fill="url(#rm-logo-glow)" />
      </svg>

      {showText && (
        <span
          className={cn(
            "font-extrabold tracking-tight bg-gradient-to-r from-foreground via-foreground to-muted-foreground bg-clip-text text-transparent",
            textClassName
          )}
        >
          RackMap
        </span>
      )}
    </div>
  );
}
