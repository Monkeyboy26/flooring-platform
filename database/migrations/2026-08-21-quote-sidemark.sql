-- Quote sidemark (job reference). Shown below the customer box on the quote,
-- and carried onto the order's job_name when the quote converts.
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS sidemark VARCHAR(200);
