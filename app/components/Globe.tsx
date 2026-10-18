"use client";

import { useEffect, useRef } from "react";
import { AuthorRecord, normalizeAuthorName } from "../author-data";

export function isApproximateBirthplace(record: AuthorRecord) {
  const place = normalizeAuthorName(record.birthplace?.name ?? "");
  const country = normalizeAuthorName(record.birthplace?.country ?? "");
  return Boolean(place && country && place === country);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}

export function Globe({ locations, onSelect }: { locations: AuthorRecord[]; onSelect: (authorIds: string[]) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    let disposed = false;
    let cleanup = () => {};
    const points = [...locations.reduce((grouped, location) => {
      if (!location.birthplace) return grouped;
      const key = `${location.birthplace.latitude},${location.birthplace.longitude}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.authorIds.push(location.id); existing.names.push(location.name); existing.count += 1; existing.approximate ||= isApproximateBirthplace(location);
      } else grouped.set(key, {
        lat: location.birthplace.latitude, lng: location.birthplace.longitude, authorIds: [location.id], names: [location.name], count: 1,
        place: `${location.birthplace.name}${location.birthplace.country ? `, ${location.birthplace.country}` : ""}`, approximate: isApproximateBirthplace(location),
      });
      return grouped;
    }, new Map<string, { lat: number; lng: number; authorIds: string[]; names: string[]; count: number; place: string; approximate: boolean }>()).values()];

    void import("globe.gl").then(({ default: GlobeGL }) => {
      if (disposed) return;
      const globe = new GlobeGL(container, { rendererConfig: { antialias: true, alpha: true } })
        .globeImageUrl("/earth-night.jpg").bumpImageUrl("/earth-topology.png").backgroundColor("rgba(0,0,0,0)")
        .showAtmosphere(true).atmosphereColor("#8fc7b5").atmosphereAltitude(0.11).pointsData(points).pointLat("lat").pointLng("lng")
        .pointColor(() => "#f2c45a")
        .pointAltitude((point: object) => { const marker = point as (typeof points)[number]; return marker.approximate ? 0.015 : 0.018 + Math.min(marker.count, 8) * 0.018; })
        .pointRadius((point: object) => (point as (typeof points)[number]).approximate ? 0.22 : 0.3).pointResolution(32)
        .pointLabel((point: object) => { const marker = point as (typeof points)[number]; const heading = marker.count > 1 ? `${marker.count} authors` : marker.names[0]; const names = marker.count > 1 ? `<small>${marker.names.map(escapeHtml).join(" · ")}</small>` : ""; const precision = marker.approximate ? "<em>Country-level location</em>" : ""; return `<div class="globe-tooltip"><b>${escapeHtml(heading)}</b><span>${escapeHtml(marker.place)}</span>${precision}${names}</div>`; })
        .onPointClick((point: object) => { const marker = point as (typeof points)[number]; globe.pointOfView({ lat: marker.lat, lng: marker.lng, altitude: 1.55 }, 900); onSelect(marker.authorIds); });
      const controls = globe.controls(); controls.autoRotate = false; controls.enableDamping = true; controls.dampingFactor = 0.08; controls.minDistance = 180; controls.maxDistance = 520;
      globe.pointOfView({ lat: 18, lng: 0, altitude: 2.05 }, 0);
      const resize = () => globe.width(container.clientWidth).height(container.clientHeight);
      const observer = new ResizeObserver(resize); observer.observe(container); resize();
      cleanup = () => { observer.disconnect(); controls.autoRotate = false; (globe as unknown as { _destructor?: () => void })._destructor?.(); };
    });
    return () => { disposed = true; cleanup(); };
  }, [locations, onSelect]);
  return <div ref={containerRef} className="globe-visualization" role="img" aria-label={`Interactive globe with ${locations.length} author birth locations`} />;
}
