export type Locale = "ru" | "en";

export interface LandingContent {
  meta: { title: string; description: string };
  header: { locale: string; localeLabel: string; switchTo: string; download: string };
  hero: {
    lineOne: string;
    lineTwoBeforeDisk: string;
    lineTwoAfterDisk: string;
    accessibleTitle: string;
    subtitle: string;
    download: string;
    github: string;
  };
  stats: {
    computerName: string;
    used: string;
    total: string;
    lastScan: string;
    accessibleLabel: string;
    legendLabel: string;
    legend: Array<{ label: string; value: string; separator: ":" | "·" }>;
  };
  features: {
    headingFirst: string;
    headingSecond: string;
    headingAccent: string;
    accessibleLabel: string;
    cards: Array<{ title: string; description: string; icon: string }>;
  };
  screen: { alt: string; mobileBefore: string; mobileAfter: string };
  cta: {
    lineOneBeforeOs: string;
    lineOneAfterOs: string;
    lineTwoBeforeOs: string;
    lineTwoAfterOs: string;
    accessibleTitle: string;
    download: string;
    aside: string;
  };
  dialog: {
    title: string;
    mobileIntroTitle: string;
    mobileContinue: string;
    mobilePlatformsTitle: string;
    close: string;
    mac: string;
    windows: string;
    unavailable: string;
    releaseLink: string;
    fallbackTitle: string;
  };
  links: { github: string; donate: string; telegram: string; betaChat: string; unavailable: string };
  footer: { firstLine: string; secondPrefix: string; secondItalic: string };
}
