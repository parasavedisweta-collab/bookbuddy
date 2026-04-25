"use client";

import Link from "next/link";
import type { Book } from "@/lib/types";
import { relativeTime } from "@/lib/helpers";

interface BookCardProps {
  book: Book;
}

export default function BookCard({ book }: BookCardProps) {
  const isAvailable = book.status === "available";

  return (
    <Link
      href={`/book/${book.id}`}
      className="group block bg-surface-container-lowest rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-all"
    >
      {/* Cover */}
      <div className="relative aspect-[3/4] bg-surface-container-high overflow-hidden">
        {book.cover_url ? (
          <img
            src={book.cover_url}
            alt={book.title}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-on-surface-variant">
            <span className="material-symbols-outlined text-5xl">menu_book</span>
          </div>
        )}

        {/* Out of stock badge */}
        {!isAvailable && (
          <div className="absolute top-2 left-2 bg-error text-on-error text-[10px] font-bold uppercase px-2 py-1 rounded-full">
            Out of Stock
          </div>
        )}
      </div>

      {/* Info — we deliberately show the lister's child name (not the book's
          author) here. At grid scale the lister identity is the social-proof
          signal that matters ("oh, that's Mira's book"); the author shows up
          on the detail page where there's room for both. */}
      <div className="p-3 space-y-1">
        <h3 className="font-headline font-bold text-sm text-on-surface leading-tight line-clamp-2">
          {book.title}
        </h3>
        {book.child?.name && (
          <p className="text-xs text-on-surface-variant truncate flex items-center gap-1">
            <span className="material-symbols-outlined text-[14px] text-outline">
              person
            </span>
            {book.child.name}
          </p>
        )}
        <div className="flex items-center justify-between pt-1">
          {book.genre && (
            <span className="text-[10px] font-bold text-tertiary bg-tertiary-container/20 px-2 py-0.5 rounded-full uppercase">
              {book.genre}
            </span>
          )}
          <span className="text-[10px] text-outline">
            {relativeTime(book.listed_at)}
          </span>
        </div>
      </div>
    </Link>
  );
}
