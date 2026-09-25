import type { ResidencyClass } from "@geodeploy/core";
import type { LatLon } from "./haversine.js";

export interface CanonicalGeo {
  id: string;
  continent: string;
  subRegion: string;
  centroid: LatLon;
  residency: ResidencyClass;
}

// Static lookup so a business geo id or ISO-3166 country code is a table
// lookup, never a model call ("what continent is Frankfurt in" is not a
// judgment call). Centroids are representative major-city coordinates.
const TABLE: Record<string, CanonicalGeo> = {
  "eu-central": {
    id: "eu-central",
    continent: "Europe",
    subRegion: "Central Europe",
    centroid: { lat: 50.1109, lon: 8.6821 },
    residency: "eu-only",
  },
  "eu-west": {
    id: "eu-west",
    continent: "Europe",
    subRegion: "Western Europe",
    centroid: { lat: 53.3498, lon: -6.2603 },
    residency: "eu-only",
  },
  "us-east": {
    id: "us-east",
    continent: "North America",
    subRegion: "Eastern US",
    centroid: { lat: 39.0438, lon: -77.4874 },
    residency: "us-only",
  },
  "us-west": {
    id: "us-west",
    continent: "North America",
    subRegion: "Western US",
    centroid: { lat: 37.3541, lon: -121.9552 },
    residency: "us-only",
  },
  "apac-se": {
    id: "apac-se",
    continent: "Asia",
    subRegion: "Southeast Asia",
    centroid: { lat: 1.3521, lon: 103.8198 },
    residency: "none",
  },
  "apac-ne": {
    id: "apac-ne",
    continent: "Asia",
    subRegion: "Northeast Asia",
    centroid: { lat: 35.6762, lon: 139.6503 },
    residency: "none",
  },
  "sa-east": {
    id: "sa-east",
    continent: "South America",
    subRegion: "Eastern South America",
    centroid: { lat: -23.5505, lon: -46.6333 },
    residency: "in-country",
  },
  DE: { id: "DE", continent: "Europe", subRegion: "Central Europe", centroid: { lat: 52.52, lon: 13.405 }, residency: "eu-only" },
  FR: { id: "FR", continent: "Europe", subRegion: "Western Europe", centroid: { lat: 48.8566, lon: 2.3522 }, residency: "eu-only" },
  GB: { id: "GB", continent: "Europe", subRegion: "Western Europe", centroid: { lat: 51.5072, lon: -0.1276 }, residency: "none" },
  US: { id: "US", continent: "North America", subRegion: "Eastern US", centroid: { lat: 38.9072, lon: -77.0369 }, residency: "us-only" },
  JP: { id: "JP", continent: "Asia", subRegion: "Northeast Asia", centroid: { lat: 35.6762, lon: 139.6503 }, residency: "none" },
  SG: { id: "SG", continent: "Asia", subRegion: "Southeast Asia", centroid: { lat: 1.3521, lon: 103.8198 }, residency: "none" },
  BR: { id: "BR", continent: "South America", subRegion: "Eastern South America", centroid: { lat: -23.5505, lon: -46.6333 }, residency: "in-country" },
  IN: { id: "IN", continent: "Asia", subRegion: "South Asia", centroid: { lat: 28.6139, lon: 77.209 }, residency: "in-country" },
  AU: { id: "AU", continent: "Oceania", subRegion: "Australia", centroid: { lat: -33.8688, lon: 151.2093 }, residency: "none" },
};

export function normalizeGeo(input: string): CanonicalGeo | undefined {
  return TABLE[input];
}

export function knownGeoIds(): string[] {
  return Object.keys(TABLE);
}
