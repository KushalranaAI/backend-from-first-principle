/** Who built this, and where to find them. The credit strip on every page reads from here, so change it in one place. */
export const BRAND = {
  name: "Kushal Rana",
  links: [
    { id: "portfolio", label: "Portfolio", href: "https://kushalranaai.github.io/" },
    { id: "linkedin", label: "LinkedIn", href: "https://www.linkedin.com/in/kushal-rana" },
    { id: "x", label: "X", href: "https://x.com/KushalranaAI" },
    { id: "medium", label: "Medium", href: "https://kushalrana448.medium.com/" },
    { id: "youtube", label: "YouTube", href: "https://www.youtube.com/@naaku-o2x" },
  ],
} as const;

export type BrandLinkId = (typeof BRAND.links)[number]["id"];

/** The family of free roadmaps this course belongs to. */
export const FAMILY = { name: "Learn in Public", hub: "https://kushalranaai.github.io/learn-in-public/" } as const;

/** The course follows the topic order of this playlist. It is credited once, in the credit strip. */
export const REFERENCE = {
  label: "Backend from first principles",
  href: "https://www.youtube.com/playlist?list=PLui3EUkuMTPgZcV0QhQrOcwMPcBCcd_Q1",
} as const;
