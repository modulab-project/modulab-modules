-- Migration 0002: add notes column to recipes
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS notes TEXT;
