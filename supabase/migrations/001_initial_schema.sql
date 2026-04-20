-- BookBuddy Initial Schema
-- Run this in your Supabase SQL editor to set up the database

-- 1. Societies
CREATE TABLE IF NOT EXISTS societies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  city TEXT,
  lat DECIMAL(10,8),
  lng DECIMAL(11,8),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Parents (linked to Supabase Auth)
CREATE TABLE IF NOT EXISTS parents (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  phone TEXT UNIQUE,
  email TEXT,
  society_id UUID REFERENCES societies(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Children
CREATE TABLE IF NOT EXISTS children (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id UUID REFERENCES parents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  age_group TEXT NOT NULL CHECK (age_group IN ('below-5', '6-8', '9-12', '12+')),
  bookbuddy_id TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 4. Books
CREATE TABLE IF NOT EXISTS books (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id UUID REFERENCES children(id) ON DELETE CASCADE,
  society_id UUID REFERENCES societies(id),
  title TEXT NOT NULL,
  author TEXT,
  genre TEXT,
  age_range TEXT,
  summary TEXT,
  cover_url TEXT,
  cover_source TEXT CHECK (cover_source IN ('api', 'user_photo', 'enhanced')),
  status TEXT DEFAULT 'available' CHECK (status IN ('available', 'borrowed', 'requested')),
  listed_at TIMESTAMPTZ DEFAULT now()
);

-- 5. Borrow Requests
CREATE TABLE IF NOT EXISTS borrow_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id UUID REFERENCES books(id) ON DELETE CASCADE,
  borrower_child_id UUID REFERENCES children(id),
  lister_child_id UUID REFERENCES children(id),
  status TEXT DEFAULT 'pending' CHECK (status IN (
    'pending', 'approved', 'declined', 'auto_declined',
    'picked_up', 'returned', 'confirmed_return'
  )),
  requested_at TIMESTAMPTZ DEFAULT now(),
  responded_at TIMESTAMPTZ,
  picked_up_at TIMESTAMPTZ,
  due_date TIMESTAMPTZ,
  returned_at TIMESTAMPTZ,
  return_confirmed_at TIMESTAMPTZ
);

-- 6. Notifications
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id UUID REFERENCES parents(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  message TEXT,
  data JSONB,
  read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_books_society_status ON books(society_id, status);
CREATE INDEX IF NOT EXISTS idx_books_child_id ON books(child_id);
CREATE INDEX IF NOT EXISTS idx_borrow_requests_borrower ON borrow_requests(borrower_child_id, status);
CREATE INDEX IF NOT EXISTS idx_borrow_requests_lister ON borrow_requests(lister_child_id, status);
CREATE INDEX IF NOT EXISTS idx_notifications_parent ON notifications(parent_id, read);

-- Row-Level Security Policies

-- Enable RLS on all tables
ALTER TABLE societies ENABLE ROW LEVEL SECURITY;
ALTER TABLE parents ENABLE ROW LEVEL SECURITY;
ALTER TABLE children ENABLE ROW LEVEL SECURITY;
ALTER TABLE books ENABLE ROW LEVEL SECURITY;
ALTER TABLE borrow_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Societies: everyone can read
CREATE POLICY "societies_read" ON societies FOR SELECT USING (true);

-- Parents: users can read/write their own row
CREATE POLICY "parents_read_own" ON parents FOR SELECT
  USING (id = auth.uid());
CREATE POLICY "parents_insert_own" ON parents FOR INSERT
  WITH CHECK (id = auth.uid());
CREATE POLICY "parents_update_own" ON parents FOR UPDATE
  USING (id = auth.uid());

-- Children: parent can manage their children
CREATE POLICY "children_read_own" ON children FOR SELECT
  USING (parent_id = auth.uid());
CREATE POLICY "children_insert_own" ON children FOR INSERT
  WITH CHECK (parent_id = auth.uid());

-- Books: anyone in the same society can read, owner can write
CREATE POLICY "books_read_society" ON books FOR SELECT
  USING (
    society_id IN (
      SELECT society_id FROM parents WHERE id = auth.uid()
    )
  );
CREATE POLICY "books_insert_own" ON books FOR INSERT
  WITH CHECK (
    child_id IN (
      SELECT id FROM children WHERE parent_id = auth.uid()
    )
  );
CREATE POLICY "books_update_own" ON books FOR UPDATE
  USING (
    child_id IN (
      SELECT id FROM children WHERE parent_id = auth.uid()
    )
  );

-- Borrow requests: borrower and lister can read; borrower can insert; lister can update
CREATE POLICY "borrow_read_involved" ON borrow_requests FOR SELECT
  USING (
    borrower_child_id IN (SELECT id FROM children WHERE parent_id = auth.uid())
    OR lister_child_id IN (SELECT id FROM children WHERE parent_id = auth.uid())
  );
CREATE POLICY "borrow_insert_borrower" ON borrow_requests FOR INSERT
  WITH CHECK (
    borrower_child_id IN (SELECT id FROM children WHERE parent_id = auth.uid())
  );
CREATE POLICY "borrow_update_involved" ON borrow_requests FOR UPDATE
  USING (
    borrower_child_id IN (SELECT id FROM children WHERE parent_id = auth.uid())
    OR lister_child_id IN (SELECT id FROM children WHERE parent_id = auth.uid())
  );

-- Notifications: parent can read their own
CREATE POLICY "notif_read_own" ON notifications FOR SELECT
  USING (parent_id = auth.uid());
CREATE POLICY "notif_update_own" ON notifications FOR UPDATE
  USING (parent_id = auth.uid());

-- Seed some demo societies
INSERT INTO societies (id, name, city, lat, lng) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Sunshine Residency', 'Mumbai', 19.0760, 72.8777),
  ('00000000-0000-0000-0000-000000000002', 'Green Meadows', 'Mumbai', 19.0840, 72.8900),
  ('00000000-0000-0000-0000-000000000003', 'Palm Heights', 'Pune', 18.5204, 73.8567),
  ('00000000-0000-0000-0000-000000000004', 'Lakeside Towers', 'Bangalore', 12.9716, 77.5946)
ON CONFLICT DO NOTHING;
