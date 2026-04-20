import type { Book, BorrowRequest } from "./types";

/**
 * Demo data for development before Supabase is connected.
 * Replace with real API calls once Supabase is set up.
 */
export const DEMO_BOOKS: Book[] = [
  {
    id: "1",
    child_id: "c1",
    society_id: "s1",
    title: "The Secret of the Whispering Woods",
    author: "Sarah J. Maas",
    genre: "Adventure",
    age_range: "9-12",
    summary:
      "A magical journey through a forest that speaks to those who listen. Follow young Elara as she uncovers ancient secrets.",
    cover_url:
      "https://covers.openlibrary.org/b/id/14829677-L.jpg",
    cover_source: "api",
    status: "available",
    listed_at: new Date(Date.now() - 2 * 86400000).toISOString(),
    child: { id: "c1", parent_id: "p1", name: "Jenny", age_group: "9-12", bookbuddy_id: "BB-A3X7", created_at: "" },
  },
  {
    id: "2",
    child_id: "c2",
    society_id: "s1",
    title: "Diary of a Wimpy Kid",
    author: "Jeff Kinney",
    genre: "Humor",
    age_range: "6-8",
    summary:
      "Greg Heffley's hilarious diary entries about surviving middle school.",
    cover_url:
      "https://covers.openlibrary.org/b/id/12648289-L.jpg",
    cover_source: "api",
    status: "available",
    listed_at: new Date(Date.now() - 5 * 86400000).toISOString(),
    child: { id: "c2", parent_id: "p2", name: "Arjun", age_group: "6-8", bookbuddy_id: "BB-K9M2", created_at: "" },
  },
  {
    id: "3",
    child_id: "c3",
    society_id: "s1",
    title: "Harry Potter and the Philosopher's Stone",
    author: "J.K. Rowling",
    genre: "Fantasy",
    age_range: "9-12",
    summary:
      "A boy discovers he's a wizard and enters a magical school full of wonder and danger.",
    cover_url:
      "https://covers.openlibrary.org/b/id/10521270-L.jpg",
    cover_source: "api",
    status: "borrowed",
    listed_at: new Date(Date.now() - 10 * 86400000).toISOString(),
    child: { id: "c3", parent_id: "p3", name: "Priya", age_group: "9-12", bookbuddy_id: "BB-R5T8", created_at: "" },
  },
  {
    id: "4",
    child_id: "c1",
    society_id: "s1",
    title: "The Magic Tree House: Dinosaurs Before Dark",
    author: "Mary Pope Osborne",
    genre: "Adventure",
    age_range: "6-8",
    summary:
      "Jack and Annie discover a tree house full of books that transport them back in time.",
    cover_url:
      "https://covers.openlibrary.org/b/id/839564-L.jpg",
    cover_source: "api",
    status: "available",
    listed_at: new Date(Date.now() - 1 * 86400000).toISOString(),
    child: { id: "c1", parent_id: "p1", name: "Jenny", age_group: "9-12", bookbuddy_id: "BB-A3X7", created_at: "" },
  },
  {
    id: "5",
    child_id: "c2",
    society_id: "s1",
    title: "Dog Man",
    author: "Dav Pilkey",
    genre: "Comics",
    age_range: "6-8",
    summary:
      "Part dog, part man, all hero — Dog Man fights crime in hilarious comic adventures.",
    cover_url:
      "https://covers.openlibrary.org/b/id/8543125-L.jpg",
    cover_source: "api",
    status: "available",
    listed_at: new Date(Date.now() - 3 * 86400000).toISOString(),
    child: { id: "c2", parent_id: "p2", name: "Arjun", age_group: "6-8", bookbuddy_id: "BB-K9M2", created_at: "" },
  },
  {
    id: "6",
    child_id: "c3",
    society_id: "s1",
    title: "Percy Jackson: The Lightning Thief",
    author: "Rick Riordan",
    genre: "Mythology",
    age_range: "9-12",
    summary:
      "Percy discovers he's the son of Poseidon and must prevent a war among the Greek gods.",
    cover_url:
      "https://covers.openlibrary.org/b/id/12547191-L.jpg",
    cover_source: "api",
    status: "borrowed",
    listed_at: new Date(Date.now() - 7 * 86400000).toISOString(),
    child: { id: "c3", parent_id: "p3", name: "Priya", age_group: "9-12", bookbuddy_id: "BB-R5T8", created_at: "" },
  },
];

export const DEMO_BORROW_REQUESTS: BorrowRequest[] = [
  {
    id: "br1",
    book_id: "3",
    borrower_child_id: "c1",
    lister_child_id: "c3",
    status: "picked_up",
    requested_at: new Date(Date.now() - 8 * 86400000).toISOString(),
    responded_at: new Date(Date.now() - 7 * 86400000).toISOString(),
    picked_up_at: new Date(Date.now() - 6 * 86400000).toISOString(),
    due_date: new Date(Date.now() + 8 * 86400000).toISOString(),
    returned_at: null,
    return_confirmed_at: null,
    book: DEMO_BOOKS[2],
    borrower_child: DEMO_BOOKS[0].child,
    lister_child: DEMO_BOOKS[2].child,
  },
  {
    id: "br2",
    book_id: "1",
    borrower_child_id: "c2",
    lister_child_id: "c1",
    status: "pending",
    requested_at: new Date(Date.now() - 1 * 86400000).toISOString(),
    responded_at: null,
    picked_up_at: null,
    due_date: null,
    returned_at: null,
    return_confirmed_at: null,
    book: DEMO_BOOKS[0],
    borrower_child: DEMO_BOOKS[1].child,
    lister_child: DEMO_BOOKS[0].child,
  },
  {
    id: "br3",
    book_id: "6",
    borrower_child_id: "c2",
    lister_child_id: "c3",
    status: "picked_up",
    requested_at: new Date(Date.now() - 5 * 86400000).toISOString(),
    responded_at: new Date(Date.now() - 4 * 86400000).toISOString(),
    picked_up_at: new Date(Date.now() - 3 * 86400000).toISOString(),
    due_date: new Date(Date.now() + 11 * 86400000).toISOString(),
    returned_at: null,
    return_confirmed_at: null,
    book: DEMO_BOOKS[5],
    borrower_child: DEMO_BOOKS[1].child,
    lister_child: DEMO_BOOKS[5].child,
  },
];
