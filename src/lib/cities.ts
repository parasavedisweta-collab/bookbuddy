const CITY_ALIASES: Record<string, string[]> = {
  Bengaluru: ["bengaluru", "bangalore", "banglore", "bengalore", "blr", "bengalooru"],
  Mumbai: ["mumbai", "bombay", "bom", "mum"],
  Delhi: ["delhi", "new delhi", "ncr", "dli", "dilli"],
  Gurugram: ["gurugram", "gurgaon", "ggn"],
  Noida: ["noida", "new okhla"],
  Chennai: ["chennai", "madras", "chen", "maa"],
  Kolkata: ["kolkata", "calcutta", "kol", "ccu"],
  Hyderabad: ["hyderabad", "hyd", "secunderabad", "cyberabad"],
  Pune: ["pune", "poona", "pnq"],
  Ahmedabad: ["ahmedabad", "amdavad", "ahd", "amd"],
  Jaipur: ["jaipur", "jpr", "pinkcity"],
  Kochi: ["kochi", "cochin", "ernakulam", "cok"],
  Thiruvananthapuram: ["thiruvananthapuram", "trivandrum", "tvm"],
  Chandigarh: ["chandigarh", "chd", "ixc"],
  Lucknow: ["lucknow", "lko"],
  Indore: ["indore", "idr"],
  Surat: ["surat", "stv"],
  Nagpur: ["nagpur", "nag"],
  Bhubaneswar: ["bhubaneswar", "bbsr", "bbi"],
  Coimbatore: ["coimbatore", "kovai", "cjb"],
};

export const CANONICAL_CITIES = Object.keys(CITY_ALIASES);

function norm(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

export function canonicaliseCity(input: string): string | null {
  const q = norm(input);
  if (!q) return null;
  for (const [canonical, aliases] of Object.entries(CITY_ALIASES)) {
    if (norm(canonical) === q) return canonical;
    if (aliases.includes(q)) return canonical;
  }
  return null;
}

export function suggestCities(query: string, limit = 6): string[] {
  const q = norm(query);
  if (!q) return [];
  const scored: Array<{ name: string; score: number }> = [];
  for (const [canonical, aliases] of Object.entries(CITY_ALIASES)) {
    const pool = [norm(canonical), ...aliases.map(norm)];
    let best = Infinity;
    for (const a of pool) {
      if (a === q) { best = 0; break; }
      if (a.startsWith(q)) best = Math.min(best, 1);
      else if (a.includes(q)) best = Math.min(best, 2);
    }
    if (best !== Infinity) scored.push({ name: canonical, score: best });
  }
  scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map((s) => s.name);
}
