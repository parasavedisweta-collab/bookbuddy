export interface Society {
  id: string;
  name: string;
  city: string | null;
  lat: number | null;
  lng: number | null;
  created_at: string;
}

export interface Parent {
  id: string;
  phone: string | null;
  email: string | null;
  society_id: string;
  created_at: string;
}

export interface Child {
  id: string;
  parent_id: string;
  name: string;
  age_group: "below-5" | "6-8" | "9-12" | "12+";
  bookbuddy_id: string;
  created_at: string;
}

export type BookStatus = "available" | "borrowed" | "requested";

export type Genre =
  | "Adventure"
  | "Fantasy"
  | "Science Fiction"
  | "Comics"
  | "Mystery"
  | "Horror"
  | "Biography"
  | "Science & Nature"
  | "History"
  | "Poetry"
  | "Fairy Tales"
  | "Mythology"
  | "Sports"
  | "Humor"
  | "Educational"
  | "Art & Craft"
  | "Puzzle & Activity"
  | "Religion & Spirituality"
  | "Self-Help"
  | "Other";

export const GENRES: Genre[] = [
  "Adventure",
  "Fantasy",
  "Science Fiction",
  "Comics",
  "Mystery",
  "Horror",
  "Biography",
  "Science & Nature",
  "History",
  "Poetry",
  "Fairy Tales",
  "Mythology",
  "Sports",
  "Humor",
  "Educational",
  "Art & Craft",
  "Puzzle & Activity",
  "Religion & Spirituality",
  "Self-Help",
  "Other",
];

export const AGE_RANGES = ["Below 5", "6-8", "9-12", "12+"] as const;
export type AgeRange = (typeof AGE_RANGES)[number];

export interface Book {
  id: string;
  child_id: string;
  society_id: string;
  title: string;
  author: string | null;
  genre: Genre | null;
  age_range: string | null;
  summary: string | null;
  cover_url: string | null;
  cover_source: "api" | "user_photo" | "enhanced" | null;
  status: BookStatus;
  listed_at: string;
  // Joined fields
  child?: Child;
}

export type BorrowStatus =
  | "pending"
  | "approved"
  | "declined"
  | "auto_declined"
  | "picked_up"
  | "returned"
  | "confirmed_return";

export interface BorrowRequest {
  id: string;
  book_id: string;
  borrower_child_id: string;
  lister_child_id: string;
  status: BorrowStatus;
  requested_at: string;
  responded_at: string | null;
  picked_up_at: string | null;
  due_date: string | null;
  returned_at: string | null;
  return_confirmed_at: string | null;
  // Joined fields
  book?: Book;
  borrower_child?: Child;
  lister_child?: Child;
}

export interface Notification {
  id: string;
  parent_id: string;
  type: string;
  message: string;
  data: Record<string, unknown> | null;
  read: boolean;
  created_at: string;
}

// Book lookup result from Google Books / Open Library
export interface BookLookupResult {
  title: string;
  series: string | null;
  subtitle: string | null;
  author: string;
  genre: string | null;
  ageRange: string | null;
  summary: string | null;
  coverUrl: string | null;
  source: "google_books" | "open_library";
  /**
   * Lower-case concatenation of title + subtitle + author (+ a slice of the
   * description) so callers can cheaply check whether OCR tokens appear
   * anywhere in the API's metadata — not just the title.
   */
  haystack: string;
}
