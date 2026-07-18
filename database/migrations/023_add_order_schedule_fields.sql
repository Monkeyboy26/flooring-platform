-- Add scheduling and notes fields to orders table
ALTER TABLE orders ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS measure_requested BOOLEAN DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS preferred_measure_date DATE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS preferred_measure_time VARCHAR(20);
