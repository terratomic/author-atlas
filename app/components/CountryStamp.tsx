const countryDetails: Record<string, { code: string; shape: "round" | "oval" | "ticket" | "arch" }> = {
  "United States": { code: "USA", shape: "ticket" }, "United States of America": { code: "USA", shape: "ticket" },
  "United Kingdom": { code: "GBR", shape: "arch" }, England: { code: "ENG", shape: "arch" }, Scotland: { code: "SCO", shape: "oval" }, Ireland: { code: "IRL", shape: "round" },
  Canada: { code: "CAN", shape: "ticket" }, Mexico: { code: "MEX", shape: "arch" }, Colombia: { code: "COL", shape: "oval" }, Argentina: { code: "ARG", shape: "round" },
  Brazil: { code: "BRA", shape: "ticket" }, Nigeria: { code: "NGA", shape: "arch" }, Ghana: { code: "GHA", shape: "round" }, Kenya: { code: "KEN", shape: "oval" },
  "South Africa": { code: "ZAF", shape: "ticket" }, India: { code: "IND", shape: "arch" }, Pakistan: { code: "PAK", shape: "round" }, China: { code: "CHN", shape: "ticket" },
  Japan: { code: "JPN", shape: "round" }, "South Korea": { code: "KOR", shape: "oval" }, Australia: { code: "AUS", shape: "ticket" }, "New Zealand": { code: "NZL", shape: "arch" },
  France: { code: "FRA", shape: "oval" }, Germany: { code: "DEU", shape: "ticket" }, Italy: { code: "ITA", shape: "arch" }, Spain: { code: "ESP", shape: "round" },
  Portugal: { code: "PRT", shape: "oval" }, Russia: { code: "RUS", shape: "ticket" }, Ukraine: { code: "UKR", shape: "arch" }, Poland: { code: "POL", shape: "round" },
  Sweden: { code: "SWE", shape: "ticket" }, Norway: { code: "NOR", shape: "oval" }, Egypt: { code: "EGY", shape: "arch" }, Turkey: { code: "TUR", shape: "round" },
  Iran: { code: "IRN", shape: "ticket" }, Israel: { code: "ISR", shape: "oval" },
};

const countryFlags: Record<string, string> = {
  Fiji: "fj", Iceland: "is", Denmark: "dk", Finland: "fi", Netherlands: "nl", Belgium: "be", Switzerland: "ch", Austria: "at", Greece: "gr", Chile: "cl",
  Peru: "pe", Cuba: "cu", Jamaica: "jm", Ethiopia: "et", Morocco: "ma", Algeria: "dz", Iraq: "iq", Lebanon: "lb", Syria: "sy", Afghanistan: "af",
  Bangladesh: "bd", Nepal: "np", Vietnam: "vn", Thailand: "th", Philippines: "ph", Indonesia: "id", Singapore: "sg", Malaysia: "my", Taiwan: "tw", Serbia: "rs", Palestine: "ps",
};

const countryArtOrder = [
  "United States", "United Kingdom", "England", "Scotland", "Ireland", "Canada", "Mexico", "Colombia", "Argentina", "Brazil", "Nigeria", "Ghana",
  "Kenya", "South Africa", "India", "Pakistan", "China", "Japan", "South Korea", "Australia", "New Zealand", "France", "Germany", "Italy",
  "Spain", "Portugal", "Russia", "Ukraine", "Poland", "Sweden", "Norway", "Egypt", "Turkey", "Iran", "Israel", "Fiji",
] as const;
const countryArt = new Map<string, number>(countryArtOrder.map((country, index) => [country, index]));
countryArt.set("United States of America", 0);

export const countryDisplayNames: Record<string, string> = { "United States": "United States of America" };

type CountryVisual = { code: string; shape: "round" | "oval" | "ticket" | "arch"; tone: number; flagCode?: string; artIndex?: number };

function countryVisual(country?: string): CountryVisual {
  if (!country) return { code: "—", shape: "round", tone: 0 };
  const shape = (["round", "oval", "ticket", "arch"] as const)[country.length % 4];
  const details = countryDetails[country] ?? { flagCode: countryFlags[country], code: country.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase(), shape };
  const tone = [...country].reduce((total, character) => total + character.charCodeAt(0), 0) % 4;
  return { ...details, artIndex: countryArt.get(country), tone };
}

export function CountryStamp({ country, count, compact = false }: { country?: string; count?: number; compact?: boolean }) {
  const visual = countryVisual(country);
  return <span className={`country-stamp shape-${visual.shape} tone-${visual.tone} ${compact ? "is-compact" : ""}`} title={country ?? "Country unresolved"}>
    {visual.artIndex !== undefined
      ? <span className="stamp-art" aria-hidden="true" style={{ WebkitMaskImage: `url(/country-art/${visual.artIndex}.png)`, maskImage: `url(/country-art/${visual.artIndex}.png)` }} />
      : visual.flagCode
        ? <span className="stamp-flag-image" aria-hidden="true" style={{ backgroundImage: `url(https://cdn.jsdelivr.net/gh/lipis/flag-icons/flags/4x3/${visual.flagCode}.svg)` }} />
        : <span className="stamp-monogram" aria-hidden="true">{visual.code}</span>}
    <span className="stamp-code">{visual.code}</span>
    <span className="stamp-country">{country ?? "Unresolved"}</span>
    {count !== undefined && <b>{String(count).padStart(2, "0")} AUTHORS</b>}
  </span>;
}
