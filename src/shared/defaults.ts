import {
  type AppSettings,
  type PersonaConfig
} from "./contracts.js";

export const defaultSettings: AppSettings = {
  browserChannel: "chromium",
  autoRestoreSessions: true,
  autoClosePopupsDuringNavigation: false,
  showAccountInfoOverlay: false,
  postRegistrationDepositEnabled: true,
  customDepositAmounts: [],
  reducedMotion: false,
  themeMode: "light",
  exportDirectory: "",
  screenLayout: {
    version: 2,
    monitors: [
      {
        displayId: "primary",
        enabled: true,
        mode: "grid",
        columns: 4,
        rows: 1
      }
    ]
  },
  automationStartDelaySeconds: 20,
  domainBlockEnabled: true,
  blockedDomains: [
    "global.esport001.com",
    "global.esport002.com",
    "esport001.com",
    "esport002.com",
    "global2.esportlive.vip"
  ]
};

export function buildDefaultPersona(profileId: string, name: string): PersonaConfig {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    profileId,
    version: 1,
    name: `${name} Persona`,
    userAgent: "",
    locale: "pt-BR",
    timezone: "America/Sao_Paulo",
    viewport: {
      width: 1440,
      height: 960,
      deviceScaleFactor: 1
    },
    geolocation: {
      latitude: -23.5505,
      longitude: -46.6333,
      accuracy: 24
    },
    allowNotifications: false,
    allowClipboard: true,
    webRtcMode: "relay-only",
    dnsMode: "proxy-first",
    leakProtection: "strict",
    headers: [
      {
        key: "Accept-Language",
        value: "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
      }
    ],
    launchArgs: [
      "--disable-session-crashed-bubble",
      "--disable-features=TranslateUI"
    ],
    createdAt: now,
    updatedAt: now
  };
}
