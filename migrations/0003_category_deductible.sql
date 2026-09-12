-- How much of a category is deductible. Meals are 50% by law even when the
-- meal was entirely for business, which is a different thing from the
-- per-expense business-use split. Everything defaults to 100%.
ALTER TABLE categories ADD COLUMN deduct_pct INTEGER NOT NULL DEFAULT 100;
