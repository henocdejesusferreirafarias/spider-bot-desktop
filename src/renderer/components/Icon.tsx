import type { CSSProperties } from "react";

const paths: Record<string, string> = {
  dashboard: "M4 5h7v6H4zM13 5h7v10h-7zM4 13h7v6H4zM13 17h7v2h-7z",
  bug: "M8 8h8M9 4l1.5 3M15 4l-1.5 3M5 9l2.5 1M19 9l-2.5 1M5 15l2.5-1M19 15l-2.5-1M9 20l1.5-3M15 20l-1.5-3M8 11v2a4 4 0 0 0 8 0v-2a4 4 0 0 0-8 0Z",
  profiles: "M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm7 9a7 7 0 0 0-14 0",
  proxies: "M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4",
  pixKeys: "M8.5 14.5a5.5 5.5 0 1 1 3.9-1.6L21 21h-4v-3h-3v-3h-3l-1.1-1.1a5.5 5.5 0 0 1-1.4.6ZM6 8.5A1.5 1.5 0 1 0 7.5 7 1.5 1.5 0 0 0 6 8.5Z",
  automations: "M13 3 4 14h6l-1 7 9-11h-6z",
  screens: "M4 5h16v11H4zM9 20h6M12 16v4M7 8h4v3H7zM13 8h4v3h-4z",
  activity: "M4 14h4l2-6 4 10 2-4h4",
  settings: "M12 8.5A3.5 3.5 0 1 0 15.5 12 3.5 3.5 0 0 0 12 8.5Zm0-5.5 1.1 2.3 2.5.3.6 2.4 2 1.5-1.3 2.2 1.3 2.2-2 1.5-.6 2.4-2.5.3L12 21l-1.1-2.3-2.5-.3-.6-2.4-2-1.5 1.3-2.2-1.3-2.2 2-1.5.6-2.4 2.5-.3z",
  play: "M8 6v12l10-6z",
  stop: "M7 7h10v10H7z",
  plus: "M12 5v14M5 12h14",
  minus: "M6 12h12",
  maximize: "M8 4H4v4M16 4h4v4M20 16v4h-4M8 20H4v-4",
  cockpit: "M4 15h16v4H4zM7 5h10v8H7zM9 17h6",
  pin: "M12 2a3 3 0 0 0-3 3c0 1 .5 2 1 2.5V10H7v4h2v6h6v-6h2v-4h-3V7.5c.5-.5 1-1.5 1-2.5a3 3 0 0 0-3-3z",
  close: "M7 7l10 10M17 7 7 17",
  refresh: "M20 12a8 8 0 1 1-2.3-5.7M20 4v6h-6",
  export: "M12 4v10M8 10l4 4 4-4M5 18h14",
  archive: "M4 7h16v3H4zM6 10h12v9H6zM10 13h4",
  duplicate: "M9 9V5h10v10h-4M5 9h10v10H5z",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  search: "m20 20-3.5-3.5M17 10.5A6.5 6.5 0 1 1 10.5 4 6.5 6.5 0 0 1 17 10.5Z",
  rocket: "M5 19l3.5-1 8.2-8.2a3.8 3.8 0 0 0 1-3.2l-.2-1.4-1.4-.2a3.8 3.8 0 0 0-3.2 1L4.7 14.2 4 17.6z",
  more: "M12 7h.01M12 12h.01M12 17h.01",
  shield: "M12 3l8 3v5c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6zM9 12l2 2 4-4",
  show: "M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  hide: "M3 3l18 18M10.6 10.6a3 3 0 0 1 4.2 4.2M6.7 6.7A10 10 0 0 0 2 12s3 7 10 7a10 10 0 0 0 5.3-1.7M16.3 16.3A3 3 0 0 1 12 12",
  alert: "M12 2l10 18H2zM12 9v4M12 16h.01"
};

export function Icon({
  name,
  size = 18,
  style
}: {
  name: keyof typeof paths;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      aria-hidden="true"
      className="icon"
      viewBox="0 0 24 24"
      style={{
        width: size,
        height: size,
        ...style
      }}
    >
      <path d={paths[name]} />
    </svg>
  );
}
