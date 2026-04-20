"use client";

import { GENRES, type Genre } from "@/lib/types";

interface GenreChipsProps {
  selected: Genre | null;
  onSelect: (genre: Genre | null) => void;
}

export default function GenreChips({ selected, onSelect }: GenreChipsProps) {
  return (
    <div className="flex gap-2 overflow-x-auto hide-scrollbar py-2 px-1">
      <button
        onClick={() => onSelect(null)}
        className={`flex-shrink-0 px-4 py-2 rounded-full text-xs font-bold uppercase tracking-wider transition-all ${
          selected === null
            ? "bg-primary text-on-primary"
            : "bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest"
        }`}
      >
        All
      </button>
      {GENRES.map((genre) => (
        <button
          key={genre}
          onClick={() => onSelect(genre === selected ? null : genre)}
          className={`flex-shrink-0 px-4 py-2 rounded-full text-xs font-bold uppercase tracking-wider transition-all whitespace-nowrap ${
            genre === selected
              ? "bg-primary text-on-primary"
              : "bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest"
          }`}
        >
          {genre}
        </button>
      ))}
    </div>
  );
}
