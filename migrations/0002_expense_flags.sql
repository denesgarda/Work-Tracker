-- Lets an expense be flagged for attention — missing information, needs
-- review, potentially risky — with an optional reason. Defaults leave every
-- existing expense unflagged.
ALTER TABLE expenses ADD COLUMN flagged   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE expenses ADD COLUMN flag_note TEXT    NOT NULL DEFAULT '';
