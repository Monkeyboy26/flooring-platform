import { run } from './scrapers/emser-catalog.js';

// Mock DB pool
const mockPool = {
    query: async (qs, params) => {
        console.log('[DB Mock Query]:', qs.trim().split('\n')[0], params ? JSON.stringify(params) : '');
        if (qs.includes('INSERT INTO vendors')) {
            return { rows: [{ id: 999 }] };
        }
        if (qs.includes('SELECT s.id AS sku_id')) {
            return { rows: [] };
        }
        if (qs.includes('SELECT id, slug FROM categories')) {
            return { rows: [{ id: 101, slug: 'porcelain-tile' }, { id: 102, slug: 'natural-stone' }] };
        }
        if (qs.includes('INSERT INTO products')) {
            return { rows: [{ id: 1000, is_new: true }] };
        }
        if (qs.includes('INSERT INTO skus')) {
            return { rows: [{ id: 2000, is_new: true }] };
        }
        if (qs.includes('SELECT id FROM attributes')) {
            return { rows: [{ id: 3000 }] };
        }
        if (qs.includes('INSERT INTO media_assets')) {
            return { rows: [{ id: 4000, is_new: true }] };
        }
        if (qs.includes('INSERT INTO sku_attributes')) {
            return { rows: [] };
        }
        if (qs.includes('UPDATE scrape_jobs SET log')) {
            return { rows: [] };
        }
        return { rows: [] };
    }
};

const mockJob = { id: 1 };
const mockSource = { vendor_id: 999, config: { limit: 5 } }; // test on 5 products only

async function test() {
    console.log('Starting local test of emser-catalog.js...');
    try {
        await run(mockPool, mockJob, mockSource);
        console.log('Test completed successfully!');
    } catch (err) {
        console.error('Test failed:', err);
    }
}

test();
