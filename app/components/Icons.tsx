// Bliink — filled icon set, ported 1:1 from the design prototype (UI/).
// All 24×24, fill: currentColor, so they inherit text color and the accent.

type IconProps = { size?: number };

export const RadarIcon = ({ size = 18 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path fillRule="evenodd" clipRule="evenodd" d="M12 22C6.48 22 2 17.52 2 12S6.48 2 12 2s10 4.48 10 10-4.48 10-10 10Zm0-2.1a7.9 7.9 0 1 0 0-15.8 7.9 7.9 0 0 0 0 15.8Z" />
    <path d="M12 12V3.4c2.37 0 4.52.96 6.08 2.52L12 12Z" opacity="0.85" />
    <circle cx="12" cy="12" r="2.5" />
  </svg>
);

export const TransfersIcon = ({ size = 18 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M5.6 20.4c-.5 0-.9-.4-.9-.9V9.8H1.9c-.55 0-.85-.64-.5-1.06l4.6-5.5c.26-.3.74-.3 1 0l4.6 5.5c.35.42.05 1.06-.5 1.06H8.3v9.7c0 .5-.4.9-.9.9H5.6Z" />
    <path d="M16.6 3.6h1.8c.5 0 .9.4.9.9v9.7h2.8c.55 0 .85.64.5 1.06l-4.6 5.5c-.26.3-.74.3-1 0l-4.6-5.5c-.35-.42-.05-1.06.5-1.06h2.8V4.5c0-.5.4-.9.9-.9Z" />
  </svg>
);

export const MessagesIcon = ({ size = 18 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path fillRule="evenodd" clipRule="evenodd" d="M12 2.8c-5.52 0-10 3.8-10 8.5 0 2.17.95 4.14 2.52 5.64-.16 1.1-.65 2.1-1.4 2.91-.27.3-.06.79.34.76 1.72-.13 3.27-.7 4.47-1.51 1.24.45 2.62.7 4.07.7 5.52 0 10-3.8 10-8.5s-4.48-8.5-10-8.5ZM7.9 12.6a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6Zm5.4-1.3a1.3 1.3 0 1 1-2.6 0 1.3 1.3 0 0 1 2.6 0Zm2.8 1.3a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6Z" />
  </svg>
);

export const HistoryIcon = ({ size = 18 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path fillRule="evenodd" clipRule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm.95 4.4a.95.95 0 0 0-1.9 0v6c0 .33.17.64.46.81l4.2 2.5a.95.95 0 1 0 .98-1.64l-3.74-2.23V6.4Z" />
  </svg>
);

export const SettingsIcon = ({ size = 18 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <g>
      {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
        <rect key={a} x="10.7" y="1.3" width="2.6" height="4.4" rx="1.2" transform={`rotate(${a} 12 12)`} />
      ))}
    </g>
    <path fillRule="evenodd" clipRule="evenodd" d="M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm0 9.9a2.9 2.9 0 1 1 0-5.8 2.9 2.9 0 0 1 0 5.8Z" />
  </svg>
);

export const ZapIcon = ({ size = 16 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M13.23 2.06c.5-.6 1.46-.1 1.28.66L13.1 9h5c.66 0 1.02.78.6 1.28l-8.93 10.66c-.5.6-1.46.1-1.28-.66L9.9 14h-5c-.66 0-1.02-.78-.6-1.28L13.23 2.06Z" />
  </svg>
);

export const WifiIcon = ({ size = 13 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <mask id="bkWifiM">
      <rect width="24" height="24" fill="white" />
      <path d="M3.8 12.1a11.6 11.6 0 0 1 16.4 0" stroke="black" strokeWidth="1.7" fill="none" />
      <path d="M6.9 15.4a7.2 7.2 0 0 1 10.2 0" stroke="black" strokeWidth="1.7" fill="none" />
    </mask>
    <path d="M12 20.6 1.7 9.7A14.6 14.6 0 0 1 12 5.4c4 0 7.7 1.6 10.3 4.3L12 20.6Z" mask="url(#bkWifiM)" />
  </svg>
);

export const GlobeIcon = ({ size = 13 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <mask id="bkGlobeM">
      <rect width="24" height="24" fill="white" />
      <g stroke="black" strokeWidth="1.7" fill="none">
        <path d="M2 12h20" />
        <ellipse cx="12" cy="12" rx="4.6" ry="9.6" />
      </g>
    </mask>
    <circle cx="12" cy="12" r="9.6" mask="url(#bkGlobeM)" />
  </svg>
);

export const PanelLeftIcon = ({ size = 15 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="M9.5 4v16" />
  </svg>
);
