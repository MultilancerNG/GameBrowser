/** Screen dimensions only: mobile sizes do not change OS, touch, or user agent. */
export const VIEWPORT_PRESETS = [
  { kind: "desktop", label: "Laptop · 1366 × 768", value: "1366x768" },
  { kind: "desktop", label: "Desktop · 1920 × 1080", value: "1920x1080" },
  { kind: "desktop", label: "Desktop QHD · 2560 × 1440", value: "2560x1440" },
  { kind: "mobile", label: "iPhone SE size · 375 × 667", value: "375x667" },
  { kind: "mobile", label: "iPhone 14 size · 390 × 844", value: "390x844" },
  { kind: "mobile", label: "Pixel 7 size · 412 × 915", value: "412x915" },
  { kind: "mobile", label: "iPad size · 768 × 1024", value: "768x1024" },
] as const;
