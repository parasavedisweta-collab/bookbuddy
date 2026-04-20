import type { MetadataRoute } from "next";

/**
 * Dynamic PWA manifest.
 * Returns a UAT-flavoured manifest (different name, short_name, and theme
 * colour) when NEXT_PUBLIC_ENV === "uat" so installed PWAs are visually
 * distinct from production on a tester's home screen.
 */
export default function manifest(): MetadataRoute.Manifest {
  const isUat = process.env.NEXT_PUBLIC_ENV === "uat";
  return {
    name: isUat ? "BookBuddy UAT" : "BookBuddy — Kids Book Sharing",
    short_name: isUat ? "BB UAT" : "BookBuddy",
    description:
      "List one, borrow many. A peer-to-peer book sharing library for kids in your housing society.",
    start_url: "/",
    display: "standalone",
    background_color: "#fdffda",
    theme_color: isUat ? "#a65a00" : "#417000",
    orientation: "portrait",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
