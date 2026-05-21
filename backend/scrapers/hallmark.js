/**
 * Hallmark Floors — Unified Import + Image Scraper
 *
 * Source: Big D Floor Covering Supplies Hallmark Price List (12/15/2025)
 * 14 hardwood collections + 1 SPC (Courtier) = ~170 flooring SKUs + ~670 accessory SKUs
 *
 * Strategy:
 *   1. Delete all existing Hallmark data (restructuring from 164 products → ~15)
 *   2. Import price list data: 1 product per collection, colors as variant SKUs
 *   3. Create accessory SKUs per color (Reducer, Stair Nose, Threshold, T-Mold)
 *   4. Scrape hallmarkfloors.com for product images (sitemap → page → JSON-LD/og:image)
 *   5. Save images at SKU level (per-color swatch images)
 *
 * Usage: docker compose exec api node scrapers/hallmark.js
 */
import pg from 'pg';
import {
  delay, upsertProduct, upsertSku, upsertSkuAttribute,
  upsertPackaging, upsertPricing, saveSkuImages,
} from './base.js';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const BASE_URL = 'https://hallmarkfloors.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── Categories ──
const CAT = {
  eng:   '650e8400-e29b-41d4-a716-446655440021',
  solid: '650e8400-e29b-41d4-a716-446655440022',
  lvp:   '650e8400-e29b-41d4-a716-446655440030',
};

// Accessory prices (uniform across all hardwood collections)
const ACC_PRICES = { reducer: 74.00, stairNose: 109.00, threshold: 74.00, tMold: 74.00 };
const MARKUP = 2.0;

// ══════════════════════════════════════════════════════════════
// COLLECTION DATA — hardcoded from PDF (12/15/2025)
// Each color: [species, color, sku, sfCtn, boxPlt, lbsCtn, costSqft]
// Accessories: { color: [reducerSku, stairNoseSku, thresholdSku, tMoldSku] }
// ══════════════════════════════════════════════════════════════

const COLLECTIONS = [
  // ─── 1. Alta Vista ───
  {
    name: 'Alta Vista', cat: 'eng',
    desc: '4mm Sawn Cut Face, Lightly Sculpted & Wire Brushed, Handcrafted Bevel, Truecore Hardwood Centerply, Nu Oil Finish',
    size: '5/8" x 7-1/2" x RL-86"',
    colors: [
      ['Oak','Balboa','AV75OBAL-25',27,30,57,6.85],
      ['Oak','Malibu','AV75OMAL-25',27,30,57,6.85],
      ['Oak','Laguna','AV75OLAG-25',27,30,57,6.85],
      ['Oak','Del Mar','AV75ODEL-25',27,30,57,6.85],
      ['Oak','Big Sur','AV75OBIG-25',27,30,57,6.85],
      ['Oak','Cambria','AV75OCAM-25',27,30,57,6.85],
      ['Oak','Pismo','AV75OPIS-25',27,30,57,6.85],
      ['Oak','Santa Monica','AV75OSAN-25',27,30,57,6.85],
      ['Oak','Venice','AV75OVEN-25',27,30,57,6.85],
      ['Oak','Huntington','AV75OHUN-25',27,30,57,6.85],
      ['Oak','Cardiff','AV75OCRD-25',27,30,57,6.85],
      ['Oak','Doheny','AV75ODOH-25',27,30,57,6.85],
    ],
    acc: {
      'Balboa':      ['AV75OBALRD','AV75OBALSN','AV75OBALTH','AV75OBALTM'],
      'Malibu':      ['AV75OMALRD','AV75OMALSN','AV75OMALTH','AV75OMALTM'],
      'Laguna':      ['AV75OLAGRD','AV75OLAGSN','AV75OLAGTH','AV75OLAGTM'],
      'Del Mar':     ['AV75ODELRD','AV75ODELSN','AV75ODELTH','AV75ODELTM'],
      'Big Sur':     ['AV75OBIGRD','AV75OBIGSN','AV75OBIGTH','AV75OBIGTM'],
      'Cambria':     ['AV75OCAMRD','AV75OCAMSN','AV75OCAMTH','AV75OCAMTM'],
      'Pismo':       ['AV75OPISRD','AV75OPISSN','AV75OPISTH','AV75OPISTM'],
      'Santa Monica':['AV75OSANRD','AV75OSANSN','AV75OSANTH','AV75OSANTM'],
      'Venice':      ['AV75OVENRD','AV75OVENSN','AV75OVENTH','AV75OVENTM'],
      'Huntington':  ['AV75OHUNRD','AV75OHUNSN','AV75OHUNTH','AV75OHUNTM'],
      'Cardiff':     ['AV75OCRDRD','AV75OCRDSN','AV75OCRDTH','AV75OCRDTM'],
      'Doheny':      ['AV75ODOHRD','AV75ODOHSN','AV75ODOHTH','AV75ODOHTM'],
    },
  },
  // ─── 2. Avenue ───
  {
    name: 'Avenue', cat: 'eng',
    desc: '4mm Sawn Cut Face, Wire Brush (Hickory & Oak) / Light Hand Sculpted (Maple), Handcrafted Micro Bevel, Truecore Hardwood Centerply, TrueMark Glaze Tek Finish',
    size: '5/8" x 9-1/2" x 7\'2" RL',
    colors: [
      ['Maple','Pennsylvania','AVE95PENM',22.74,48,48,7.75],
      ['Maple','Lombard','AVE95LOMM',22.74,48,48,7.75],
      ['Oak','Sunset','AVE95SUNO',22.74,48,48,7.75],
      ['Oak','Rodeo','AVE95RODO',22.74,48,48,7.75],
      ['Oak','Ocean Drive','AVE95OCEO',22.74,48,48,7.75],
      ['Oak','Mulholland','AVE95MULO',22.74,48,48,7.75],
      ['Oak','Wilshire','AVE95WILO',22.74,48,48,7.75],
      ['Hickory','Michigan','AVE95MICH',22.74,48,50,7.75],
      ['Hickory','Belle Meade','AVE95BELH',22.74,48,50,7.75],
      ['Hickory','Newbury','AVE95NEWH',22.74,48,50,7.75],
    ],
    acc: {
      'Pennsylvania':['AVE95PENMRD','AVE95PENMSN','AVE95PENMTH','AVE95PENMTM'],
      'Lombard':     ['AVE95LOMMRD','AVE95LOMMSN','AVE95LOMMTH','AVE95LOMMTM'],
      'Sunset':      ['AVE95SUNORD','AVE95SUNOSN','AVE95SUNOTH','AVE95SUNOTM'],
      'Rodeo':       ['AVE95RODORD','AVE95RODOSN','AVE95RODOTH','AVE95RODOTM'],
      'Ocean Drive': ['AVE95OCEORD','AVE95OCEOSN','AVE95OCEOTH','AVE95OCEOTM'],
      'Mulholland':  ['AVE95MULORD','AVE95MULOSN','AVE95MULOTH','AVE95MULOTM'],
      'Wilshire':    ['AVE95WILORD','AVE95WILOSN','AVE95WILOTH','AVE95WILOTM'],
      'Michigan':    ['AVE95MICHRD','AVE95MICHSN','AVE95MICHTH','AVE95MICHTM'],
      'Belle Meade': ['AVE95BELHRD','AVE95BELHSN','AVE95BELHTH','AVE95BELHTM'],
      'Newbury':     ['AVE95NEWHRD','AVE95NEWHSN','AVE95NEWHTH','AVE95NEWHTM'],
    },
  },
  // ─── 3. ATC (American Traditional Classics) ───
  {
    name: 'ATC', cat: 'eng',
    desc: 'Micro Bevel, Smooth / Glaze Tek Finish, 3mm Sawn Face Wear Layer, Truecore Hardwood Centerply',
    size: '1/2" x 3-1/4" & 5" x RL-7\'2"',
    colors: [
      ['Red Oak','Natural','ATC325NATRO-S',23.47,60,37,6.49],
      ['White Oak','Natural','ATC325NATWO-S',23.47,60,37,6.49],
      ['Red Oak','Auburn','ATC325AUBRO-S',23.47,60,37,6.49],
      ['White Oak','Saddle','ATC325SADWO-S',23.47,60,37,6.49],
      ['White Oak','Linen','ATC325LINWO-S',23.47,60,37,6.49],
      ['Walnut','Natural','ATC325NATW-M',23.47,60,37,8.65],
      ['Red Oak','Auburn','ATC5AUBRO-C',24.06,60,39,7.05],
      ['White Oak','Saddle','ATC5SADWO-C',24.06,60,39,7.05],
      ['White Oak','Linen','ATC5LINWO-C',24.06,60,39,7.05],
      ['Red Oak','Natural','ATC5NATRO-S',24.06,60,39,7.19],
      ['White Oak','Natural','ATC5NATWO-S',24.06,60,39,7.19],
      ['Hickory','Buckskin','ATC5BUCH-M',24.06,60,39,7.99],
      ['Hickory','Natural','ATC5NATH-M',24.06,60,39,7.99],
      ['Maple','Haystack','ATC5HAYM-M',24.06,60,39,7.99],
      ['Walnut','Natural','ATC5NATW-M',24.06,60,39,9.09],
    ],
    // ATC has duplicate color names across sizes; key by vendor SKU instead
    // Only 5" SKUs have accessories (3.25" do not)
    accBySku: {
      'ATC5AUBRO-C': ['ATC5AUBRO-CRD','ATC5AUBRO-CSN','ATC5AUBRO-CTH','ATC5AUBRO-CTM'],
      'ATC5SADWO-C': ['ATC5SADWO-CRD','ATC5SADWO-CSN','ATC5SADWO-CTH','ATC5SADWO-CTM'],
      'ATC5LINWO-C': ['ATC5LINWO-CRD','ATC5LINWO-CSN','ATC5LINWO-CTH','ATC5LINWO-CTM'],
      'ATC5NATRO-S': ['ATC5NATRO-SRD','ATC5NATRO-SSN','ATC5NATRO-STH','ATC5NATRO-STM'],
      'ATC5NATWO-S': ['ATC5NATWO-SRD','ATC5NATWO-SSN','ATC5NATWO-STH','ATC5NATWO-STM'],
      'ATC5BUCH-M':  ['ATC5BUCH-MRD','ATC5BUCH-MSN','ATC5BUCH-MTH','ATC5BUCH-MTM'],
      'ATC5NATH-M':  ['ATC5NATH-MRD','ATC5NATH-MSN','ATC5NATH-MTH','ATC5NATH-MTM'],
      'ATC5HAYM-M':  ['ATC5HAYM-MRD','ATC5HAYM-MSN','ATC5HAYM-MTH','ATC5HAYM-MTM'],
      'ATC5NATW-M':  ['ATC5NATW-MRD','ATC5NATW-MSN','ATC5NATW-MTH','ATC5NATW-MTM'],
    },
  },
  // ─── 4. Grain & Saw ───
  {
    name: 'Grain & Saw', cat: 'eng',
    desc: 'Lightly Sculpted (Maple & Hickory), Wire Brushed (Oak) with Saw Mark, Handcrafted Micro Bevel, 1.5mm Sliced Face, Truecore Hardwood Centerply, TrueMark Glaze Tek Finish',
    size: '7/16" x 6" x RL-74"',
    colors: [
      ['Maple','Greene','GAS6GREM',24.93,66,34,4.79],
      ['Maple','Tiffany','GAS6TIFM',24.93,66,34,4.79],
      ['Hickory','Hoffman','GAS6HOFH',24.93,66,34,4.79],
      ['Hickory','Larsson','GAS6LARH',24.93,66,34,4.79],
      ['Hickory','Stickley','GAS6STIH',24.93,66,34,4.79],
      ['Oak','Ballentine','GAS6BALO',24.93,66,34,4.79],
      ['Oak','Morris','GAS6MORO',24.93,66,34,4.79],
      ['Oak','Ruskin','GAS6RUSO',24.93,66,34,4.79],
    ],
    acc: {
      'Greene':    ['GAS6GREMRD','GAS6GREMSN','GAS6GREMTH','GAS6GREMTM'],
      'Tiffany':   ['GAS6TIFMRD','GAS6TIFMSN','GAS6TIFMTH','GAS6TIFMTM'],
      'Hoffman':   ['GAS6HOFHRD','GAS6HOFHSN','GAS6HOFHTH','GAS6HOFHTM'],
      'Larsson':   ['GAS6LARHRD','GAS6LARHSN','GAS6LARHTH','GAS6LARHTM'],
      'Stickley':  ['GAS6STIHRD','GAS6STIHSN','GAS6STIHTH','GAS6STIHTM'],
      'Ballentine':['GAS6BALORD','GAS6BALOSN','GAS6BALOTH','GAS6BALOTM'],
      'Morris':    ['GAS6MORORD','GAS6MOROSN','GAS6MOROTH','GAS6MOROTM'],
      'Ruskin':    ['GAS6RUSORD','GAS6RUSOSN','GAS6RUSOTH','GAS6RUSOTM'],
    },
  },
  // ─── 5. Crestline (Solid) ───
  {
    name: 'Crestline', cat: 'solid',
    desc: '3/4" Solid Hardwood, Light-Medium Hand Scraped, Wire Brushed, Handcrafted Bevel, Nu Oil Finish',
    size: '3/4" x 5" x RL',
    colors: [
      ['Hickory','Sanford','SCR5SANH',22.60,52,73.15,7.85],
      ['Hickory','Rainier','SCR5RAIH',22.60,52,73.15,7.85],
      ['Hickory','Stratton','SCR5STRH',22.60,52,73.15,7.85],
      ['Hickory','Hood','SCR5HOON-20',22.60,52,73.15,7.85],
      ['Oak','Monroe','SCR5MONOF',22.60,52,61.58,7.29],
      ['Oak','Porter','SCR5PORRO',22.60,52,61.58,7.29],
      ['Oak','Augusta','SCR5AUGOF',22.60,52,61.58,7.29],
      ['Oak','Geneva','SCR5GENO-20',22.60,52,61.58,7.29],
      ['Oak','Montblanc','SCR5MONTO-20',22.60,52,61.58,7.29],
      ['Oak','Shasta','SCR5SHAOF-20',22.60,52,61.58,7.29],
    ],
    acc: {
      'Sanford':  ['SCR5SANHRD','SCR5SANHSN','SCR5SANHTH','SCR5SANHTM'],
      'Rainier':  ['SCR5RAIHRD','SCR5RAIHSN','SCR5RAIHTH','SCR5RAIHTM'],
      'Stratton': ['SCR5STRHRD','SCR5STRHSN','SCR5STRHTH','SCR5STRHTM'],
      'Hood':     ['SCR5HOON-20RD','SCR5HOON-20SN','SCR5HOON-20TH','SCR5HOON-20TM'],
      'Monroe':   ['SCR5MONOFRD','SCR5MONOFSN','SCR5MONOFTH','SCR5MONOFTM'],
      'Porter':   ['SCR5PORRORD','SCR5PORROSN','SCR5PORROTH','SCR5PORROTM'],
      'Augusta':  ['SCR5AUGOFRD','SCR5AUGOFSN','SCR5AUGOFTH','SCR5AUGOFTM'],
      'Geneva':   ['SCR5GENO-20RD','SCR5GENO-20SN','SCR5GENO-20TH','SCR5GENO-20TM'],
      'Montblanc':['SCR5MONTO-20RD','SCR5MONTO-20SN','SCR5MONTO-20TH','SCR5MONTO-20TM'],
      'Shasta':   ['SCR5SHAOF-20RD','SCR5SHAOF-20SN','SCR5SHAOF-20TH','SCR5SHAOF-20TM'],
    },
  },
  // ─── 6. Monterey ───
  {
    name: 'Monterey', cat: 'eng',
    desc: 'Lightly Sculpted Hand Scraped & Wire Brushed, Handcrafted Micro Bevel, 2mm Slice Cut Face, Truecore Hardwood Centerply, TrueMark Glaze Tek Finish',
    size: '1/2" x 4, 6, 8" x RL-72"',
    colors: [
      ['Hickory','Casita','MY468CASH',37.50,36,65,5.59],
      ['Hickory','Gaucho','MY468GAUH',37.50,36,65,5.59],
      ['Hickory','Puebla','MY468PUEH',37.50,36,65,5.59],
      ['Hickory','Ranchero','MY468RANH',37.50,36,65,5.59],
      ['Hickory','Palomino','MY468PALH',37.50,36,65,5.59],
      ['Red Oak','Appaloosa','MY468APRO',37.50,36,65,5.59],
      ['Red Oak','Adobe','MY468ADRO',37.50,36,65,5.59],
      ['Red Oak','Cantina','MY468CARO',37.50,36,65,5.59],
      ['Red Oak','Calgary','MY468CGRO',37.50,36,65,5.59],
      ['Oak','Villa','MY468VILO',37.50,36,65,5.59],
      ['Oak','Cheyenne','MY468CHEO',37.50,36,65,5.59],
      ['Oak','Alhambra','MY468ALHO',37.50,36,65,5.59],
    ],
    acc: {
      'Casita':    ['MY468CASHRD','MY468CASHSN','MY468CASHTH','MY468CASHTM'],
      'Gaucho':    ['MY468GAUHRD','MY468GAUHSN','MY468GAUHTH','MY468GAUHTM'],
      'Puebla':    ['MY468PUEHRD','MY468PUEHSN','MY468PUEHTH','MY468PUEHTM'],
      'Ranchero':  ['MY468RANHRD','MY468RANHSN','MY468RANHTH','MY468RANHTM'],
      'Palomino':  ['MY468PALHRD','MY468PALHSN','MY468PALTH','MY468PALHTM'],
      'Appaloosa': ['MY468APRORD','MY468APROSN','MY468APROTH','MY468APROTM'],
      'Adobe':     ['MY468ADRORD','MY468ADROSN','MY468ADROTH','MY468ADROTM'],
      'Cantina':   ['MY468CARORD','MY468CAROSN','MY468CAROTH','MY468CAROTM'],
      'Calgary':   ['MY468CGRORD','MY468CGROSN','MY468CGROTH','MY468CGROTM'],
      'Villa':     ['MY468VILORD','MY468VILOSN','MY468VILOTH','MY468VILOTM'],
      'Cheyenne':  ['MY468CHEORD','MY468CHEOSN','MY468CHEOTH','MY468CHEOTM'],
      'Alhambra':  ['MY468ALHORD','MY468ALHOSN','MY468ALHOTH','MY468ALHOTM'],
    },
  },
  // ─── 7. Novella ───
  {
    name: 'Novella', cat: 'eng',
    desc: 'Lightly Sculpted Hand Scraped (Maple & Hickory), Wire Brushed (Oak), Handcrafted Micro Bevel, 1.5mm Slice Cut Face, Truecore Hardwood Centerply',
    size: '7/16" x 6" x RL-74"',
    colors: [
      ['Maple','Frost','NO6FROM-18',24.93,66,38,4.55],
      ['Hickory','Faulkner','NO6FAUH-18',24.93,66,38,4.55],
      ['Hickory','Thoreau','NO6THOH-18',24.93,66,38,4.55],
      ['Hickory','Eliot','NO6ELIH-18',24.93,66,38,4.55],
      ['Maple','Alcott','NO6ALCM-19',24.93,66,38,4.55],
      ['Maple','Williams','NO6WILM-19',24.93,66,38,4.55],
      ['Hickory','Rand','NO6RANH-19',24.93,66,38,4.55],
      ['Hickory','Bradbury','NO6BRAH-25',24.93,66,38,4.55],
      ['Oak','Hemingway','NO6HEMO-18',24.93,66,38,4.55],
      ['Oak','Twain','NO6TWAO-18',24.93,66,38,4.55],
      ['Oak','Hawthorne','NO6HAWO-18',24.93,66,38,4.55],
      ['Oak','Emerson','NO6EMEO-19',24.93,66,38,4.55],
      ['Oak','Whitman','NO6WHIO-19',24.93,66,38,4.55],
      ['Red Oak','Morrison','NO6MORRO-25',24.93,66,38,4.55],
      ['Red Oak','London','NO6LONRO-25',24.93,66,38,4.55],
      ['Red Oak','Salinger','NO6SALRO-25',24.93,66,38,4.55],
      ['Red Oak','Lovecraft','NO6LOVRO-25',24.93,66,38,4.55],
    ],
    acc: {
      'Frost':     ['NO6FROM1RD','NO6FROM1SN','NO6FROM1TH','NO6FROM1TM'],
      'Faulkner':  ['NO6FAUH1RD','NO6FAUH1SN','NO6FAUH1TH','NO6FAUH1TM'],
      'Thoreau':   ['NO6THOH1RD','NO6THOH1SN','NO6THOH1TH','NO6THOH1TM'],
      'Eliot':     ['NO6ELIH1RD','NO6ELIH1SN','NO6ELIH1TH','NO6ELIH1TM'],
      'Melville':  ['NO6MELH1RD','NO6MELH1SN','NO6MELH1TH','NO6MELH1TM'],
      'Alcott':    ['NO6ALCMRD','NO6ALCMSN','NO6ALCMTH','NO6ALCMTM'],
      'Williams':  ['NO6WILMRD','NO6WILMSN','NO6WILMTH','NO6WILMTM'],
      'Rand':      ['NO6RANMRD','NO6RANMSN','NO6RANMTH','NO6RANMTM'],
      'Hemingway': ['NO6HEMO1RD','NO6HEMO1SN','NO6HEMO1TH','NO6HEMO1TM'],
      'Twain':     ['NO6TWAO1RD','NO6TWAO1SN','NO6TWAO1TH','NO6TWAO1TM'],
      'Hawthorne': ['NO6HAWO1RD','NO6HAWO1SN','NO6HAWO1TH','NO6HAWO1TM'],
      'Emerson':   ['NO6EMEORD','NO6EMEOSN','NO6EMEOTH','NO6EMEOTM'],
      'Whitman':   ['NO6WHIORD','NO6WHIOSN','NO6WHIOTH','NO6WHIOTM'],
      'Bradbury':  ['NO6BRAHRD','NO6BRAHSN','NO6BRAHTH','NO6BRAHTM'],
      'Morrison':  ['NO6MORRORD','NO6MORROSN','NO6MORROTH','NO6MORROTM'],
      'London':    ['NO6LONRORD','NO6LONROSN','NO6LONROTH','NO6LONROTM'],
      'Salinger':  ['NO6SALRORD','NO6SALROSN','NO6SALROTH','NO6SALROTM'],
      'Lovecraft': ['NO6LOVRORD','NO6LOVROSN','NO6LOVROTH','NO6LOVROTM'],
    },
  },
  // ─── 8. Organic Solid ───
  {
    name: 'Organic Solid', cat: 'solid',
    desc: '3/4" Solid Hardwood, Hand Scraped with Sawn Cut Face, Handcrafted Bevel, Nu Oil Finish',
    size: '3/4" x 3-1/4" & 4" x RL-6\'2"',
    colors: [
      ['Oak','Caraway','SOR34CARO',16.70,55,43,7.99],
      ['Oak','Fennel','SOR34FENO',16.70,55,43,7.99],
      ['Oak','Tarragon','SOR34TARO',16.70,55,43,7.99],
      ['Oak','Sorrel','SO34SORO',16.70,55,43,7.99],
      ['Hickory','Moroccan','SOR34MORH',16.70,55,50,7.99],
      ['Hickory','Tulsi','SOR34TULH',16.70,55,50,7.99],
      ['Hickory','Nutmeg','SOR34NUTH',16.70,55,50,7.99],
      ['Hickory','Turmeric','SOR34TURH',16.70,55,50,7.99],
      ['Walnut','Tamarind','SOR34TAMW',16.70,55,45,8.65],
      ['Red Oak','Poppy Seed','SO34POPR',16.70,55,43,7.99],
    ],
    acc: {
      'Caraway':    ['SOR34CARORD','SOR34CAROSN','SOR34CAROTH','SOR34CAROTM'],
      'Fennel':     ['SOR34FENORD','SOR34FENOSN','SOR34FENOTH','SOR34FENOTM'],
      'Tarragon':   ['SOR34TARORD','SOR34TAROSN','SOR34TAROTH','SOR34TAROTM'],
      'Sorrel':     ['SO34SOORD','SO34SOROSN','SO34SOROTH','SO34SOROTM'],
      'Poppy Seed': ['SO34POPRRD','SO34POPRSN','SO34POPRTH','SO34POPRTM'],
      'Moroccan':   ['SOR34MORHRD','SOR34MORHSN','SOR34MORHTH','SOR34MORHTM'],
      'Tulsi':      ['SOR34TULHRD','SOR34TULHSN','SOR34TULHTH','SOR34TULHTM'],
      'Nutmeg':     ['SOR34NUTHRD','SOR34NUTHSN','SOR34NUTHTH','SOR34NUTHTM'],
      'Turmeric':   ['SOR34TURHRD','SOR34TURHSN','SOR34TURHTH','SOR34TURHTM'],
      'Tamarind':   ['SOR34TAMWRD','SOR34TAMWSN','SOR34TAMWTH','SOR34TAMWTM'],
    },
  },
  // ─── 9. Organic 567 ───
  {
    name: 'Organic 567', cat: 'eng',
    desc: 'Light Hand Scraped, Sawn Texture, Wire Brushed, Handcrafted Bevel, 4mm Sawn Cut Face, Truecore Hardwood Centerply, Nu Oil Finish',
    size: '5/8" x 5, 6, 7-1/2" x RL-6\'2"',
    colors: [
      ['Hickory','Chamomile','EOR567CHAH',19.20,57,41.90,7.19],
      ['Hickory','Darjeeling','EOR567DARH',19.20,57,41.90,7.19],
      ['Hickory','Oolong','EOR567OOLH',19.20,57,41.90,7.19],
      ['Oak','Chai','EOR567CHAO',19.20,57,41.90,7.19],
      ['Oak','Gunpowder','EOR567GUNO',19.20,57,41.90,7.19],
      ['Oak','Pekoe','EOR567PEKO',19.20,57,41.90,7.19],
      ['Oak','Hibiscus','EOR567HIBO',19.20,57,41.90,7.19],
      ['Oak','Marigold','EOR567MARO',19.20,57,41.90,7.19],
      ['Oak','Eucalyptus','EOR567EUCO',19.20,57,41.90,7.19],
      ['Oak','Ginseng','EOR567GINO',19.20,57,41.90,7.19],
      ['Red Oak','Yerba','EOR567YERRO-25',19.20,57,41.90,7.19],
      ['Red Oak','Rosehip','EOR567ROSRO-25',19.20,57,41.90,7.19],
      ['Hickory','Valarian','EOR567VALH-25',19.20,57,41.90,7.19],
    ],
    acc: {
      'Chamomile':  ['EOR567CHAHRD','EOR567CHAHSN','EOR567CHAHTH','EOR567CHAHTM'],
      'Darjeeling': ['EOR567DARHRD','EOR567DARHSN','EOR567DARHTH','EOR567DARHTM'],
      'Oolong':     ['EOR567OOLHRD','EOR567OOLHSN','EOR567OOLHTH','EOR567OOLHTM'],
      'Chai':       ['EOR567CHAORD','EOR567CHAOSN','EOR567CHAOTH','EOR567CHAOTM'],
      'Gunpowder':  ['EOR567GUNORD','EOR567GUNOSN','EOR567GUNOTH','EOR567GUNOTM'],
      'Pekoe':      ['EOR567PEKORD','EOR567PEKOSN','EOR567PEKOTH','EOR567PEKOTM'],
      'Hibiscus':   ['EOR567HIBORD','EOR567HIBOSN','EOR567HIBOTH','EOR567HIBOTM'],
      'Marigold':   ['EOR567MARORD','EOR567MAROSN','EOR567MAROTH','EOR567MAROTM'],
      'Eucalyptus': ['EOR567EUCORD','EOR567EUCOSN','EOR567EUCOTH','EOR567EUCOTM'],
      'Ginseng':    ['EOR567GINORD','EOR567GINOSN','EOR567GINOTH','EOR567GINOTM'],
      'Yerba':      ['EOR567YERRORD','EOR567YERROSN','EOR567YERROTH','EOR567YERROTM'],
      'Rosehip':    ['EOR567ROSRORD','EOR567ROSROSN','EOR567ROSROTH','EOR567ROSROTM'],
      'Valarian':   ['EOR567VALHRD','EOR567VALHSN','EOR567VALHTH','EOR567VALHTM'],
    },
  },
  // ─── 10. Serenity ───
  {
    name: 'Serenity', cat: 'eng',
    desc: '4mm Sawn Cut Face, Light Wirebrush OR Smooth, Micro Bevel, Truecore Hardwood Centerply, GlazeTek Finish',
    size: '5/8" x 7-1/2" x 7\'2" RL',
    finishCol: true, // Serenity has a "Finish" column (Smooth / Light Brush)
    colors: [
      ['Oak','Dream','SE75ODRE',27,45,56,7.65,'Smooth'],
      ['Oak','Honest','SE75OHON',27,45,56,7.65,'Light Brush'],
      ['Oak','Tranquil','SE75OTRA',27,45,56,7.65,'Smooth'],
      ['Oak','Cozy','SE75OCOZ',27,45,56,7.65,'Smooth'],
      ['Oak','Pure','SE75OPUR',27,45,56,7.65,'Light Brush'],
      ['Oak','Peace','SE75OPEA',27,45,56,7.65,'Light Brush'],
      ['Oak','Serene','SE75OSER',27,45,56,7.65,'Smooth'],
      ['Oak','Bliss','SE75OBLI',27,45,56,7.65,'Smooth'],
      ['Oak','Fair','SE75OFAI',27,45,56,7.65,'Smooth'],
      ['Oak','Calm','SE75OCAL',27,45,56,7.65,'Smooth'],
      ['Oak','Clear','SE75OCLE',27,45,56,7.65,'Smooth'],
      ['Oak','Aglow','SE75OAGL',27,45,56,7.65,'Light Brush'],
    ],
    acc: {
      'Dream':   ['SE75ODRERD','SE75ODRESN','SE75ODRETH','SE75ODRETM'],
      'Honest':  ['SE75OHONRD','SE75OHONSN','SE75OHONTH','SE75OHONTM'],
      'Tranquil':['SE75OTRARD','SE75OTRASN','SE75OTRATH','SE75OTRATM'],
      'Cozy':    ['SE75OCOZRD','SE75OCOZSN','SE75OCOZTH','SE75OCOZTM'],
      'Pure':    ['SE75OPURRD','SE75OPURSN','SE75OPURTH','SE75OPURTM'],
      'Peace':   ['SE75OPEARD','SE75OPEASN','SE75OPEATH','SE75OPEATM'],
      'Serene':  ['SE75OSERRD','SE75OSERSN','SE75OSERTH','SE75OSERTM'],
      'Bliss':   ['SE75OBLIRD','SE75OBLISN','SE75OBLITH','SE75OBLITM'],
      'Fair':    ['SE75OFAIRD','SE75OFAISN','SE75OFAITH','SE75OFAITM'],
      'Calm':    ['SE75OCALRD','SE75OCALSN','SE75OCALTH','SE75OCALTM'],
      'Clear':   ['SE75OCLERD','SE75OCLESN','SE75OCLETH','SE75OCLETM'],
      'Aglow':   ['SE75OAGLRD','SE75OAGLSN','SE75OAGLTH','SE75OAGLTM'],
    },
  },
  // ─── 11. Emporium ───
  {
    name: 'Emporium', cat: 'eng',
    desc: '4mm Sawn Cut Face, Light Smooth, Micro Bevel, Truecore Hardwood Centerply, GlazeTek Finish, Herringbone Pattern',
    size: '5/8" x 3.54" x 17.72"',
    colors: [
      ['Oak','Quartz','DE35QUAO',21.8,24,46,7.85],
      ['Oak','Opal','DE35OPAO',21.8,24,46,7.85],
      ['Oak','Crystal','DE35CRYO',21.8,24,46,7.85],
      ['Oak','Amber','DE35AMBO',21.8,24,46,7.85],
      ['Oak','Agate','DE35AGAO',21.8,24,46,7.85],
      ['Oak','Obsidian','DE35OBSO',21.8,24,46,7.85],
    ],
    acc: {
      'Quartz':  ['DE35QUAORD','DE35QUAOSN','DE35QUAOTH','DE35QUAOTM'],
      'Opal':    ['DE35OPAORD','DE35OPAOSN','DE35OPAOTH','DE35OPAOTM'],
      'Crystal': ['DE35CRYORD','DE35CRYOSN','DE35CRYOTH','DE35CRYOTM'],
      'Amber':   ['DE35AMBORD','DE35AMBOSN','DE35AMBOTH','DE35AMBOTM'],
      'Agate':   ['DE35AGAORD','DE35AGAOSN','DE35AGAOTH','DE35AGAOTM'],
      'Obsidian':['DE35OBSORD','DE35OBSOSN','DE35OBSOTH','DE35OBSOTM'],
    },
  },
  // ─── 12. True ───
  {
    name: 'True', cat: 'eng',
    desc: 'Replicated Real Driftwood, Barn Wood & Ancient Wood Texture, 3mm Through-Color Wear Layer, Sawn-Cut Grain, Handcrafted Bevel, Truecore2 Core, Nu Oil Super-Matte Finish',
    size: '5/8" x 7-1/2" x 6\'2" RL',
    colors: [
      ['Oak','Onyx','TR75ONYO-25',23.31,50,49,7.99],
      ['Oak','Gardenia','TR75ORAH-25',23.31,50,49,7.99],
      ['Oak','Neroli','TR75ORRM-25',23.31,50,49,7.99],
      ['Oak','Lemon Grass','TR75AMBP-25',23.31,50,49,7.99],
      ['Oak','Ginger Lilly','TR75GINO',31.08,40,50,7.99],
      ['Oak','Silver Needle','TR75SILO',31.08,40,50,7.99],
      ['Hickory','Orange Blossom','TR75ORAH',31.08,40,50,7.99],
      ['Hickory','Magnolia','TR75MAGH',31.08,40,50,7.99],
      ['Hickory','Jasmine','TR75JASH',31.08,40,50,7.99],
      ['Maple','Juniper','TR75JUNM',31.08,40,50,7.99],
      ['Maple','Orris','TR75ORRM',31.08,40,50,7.99],
      ['Pine','Amber','TR75AMBP',31.08,40,50,7.99],
      ['Oak','Dahlia','TR75DAHO-25',23.31,50,49,7.99],
      ['Hickory','Azalea','TR75AZAH-25',23.31,50,49,7.99],
      ['Oak','Bergamot','TR75BERO-25',23.31,50,49,7.99],
      ['Oak','Lotus','TR75LOTO-25',23.31,50,49,7.99],
    ],
    acc: {
      'Onyx':           ['TR75ONYORD','TR75ONYOSN','TR75ONYOTH','TR75ONYOTM'],
      'Gardenia':       ['TR75GARORD','TR75GAROSN','TR75GAROTH','TR75GAROTM'],
      'Neroli':         ['TR75NERORD','TR75NEROSN','TR75NEROTH','TR75NEROTM'],
      'Lemon Grass':    ['TR75LEMORD','TR75LEMOSN','TR75LEMOTH','TR75LEMOTM'],
      'Ginger Lilly':   ['TR75GINORD','TR75GINOSN','TR75GINOTH','TR75GINOTM'],
      'Silver Needle':  ['TR75SILORD','TR75SILOSN','TR75SILOTH','TR75SILOTM'],
      'Orange Blossom': ['TR75ORAHRD','TR75ORAHSN','TR75ORAHTH','TR75ORAHTM'],
      'Magnolia':       ['TR75MAGHRD','TR75MAGHSN','TR75MAGTHH','TR75MAGHTM'],
      'Jasmine':        ['TR75JASHRD','TR75JASHSN','TR75JASHTH','TR75JASHTM'],
      'Juniper':        ['TR75JUNMRD','TR75JUNMSN','TR75JUNMTH','TR75JUNMTM'],
      'Orris':          ['TR75ORRMRD','TR75ORRMSN','TR75ORRMTH','TR75ORRMTM'],
      'Amber':          ['TR75AMBPRD','TR75AMBPSN','TR75AMBPTH','TR75AMBPTM'],
      'Dahlia':         ['TR75DAHORD','TR75DAHOSN','TR75DAHOTH','TR75DAHOTM'],
      'Azalea':         ['TR75AZAHRD','TR75AZAHSN','TR75AZAHTH','TR75AZAHTM'],
      'Bergamot':       ['TR75BERORD','TR75BEROSN','TR75BEROTH','TR75BEROTM'],
      'Lotus':          ['TR75LOTORD','TR75LOTOSN','TR75LOTOTH','TR75LOTOTM'],
    },
  },
  // ─── 13. Ventura ───
  {
    name: 'Ventura', cat: 'eng',
    desc: 'Wire Brushed with Detailed Coloring, Handcrafted Micro Bevel, 2mm Slice Cut Face, Truecore Hardwood Centerply',
    size: '1/2" x 7-1/2" x RL-86"',
    colors: [
      ['Oak','Seashell','VE75SEAO-25',36,30,60,5.15],
      ['Oak','Marina','VE75MARO-25',36,30,60,5.15],
      ['Oak','Mangrove','VE75MANO-25',36,30,60,5.15],
      ['Oak','Sandal','VE75SANO-25',36,30,60,5.15],
      ['Oak','Pearl','VE75PEAO-25',36,30,60,5.15],
      ['Hickory','Sandbar','VE75SANH-25',36,30,60,5.15],
      ['Walnut','Maritime','VE75MARW-25',36,30,60,6.55],
      ['Oak','White Cap','VE75WHIO-25',36,30,60,5.15],
      ['Oak','Dune','VE75DUNO-25',36,30,60,5.15],
      ['Oak','Pier','VE75PIEO-25',36,30,60,5.15],
      ['Oak','Wharf','VE75WHAO-25',36,30,60,5.15],
      ['Hickory','Catamaran','VE75CATH-25',36,30,60,5.15],
      ['Hickory','Hampton','VE75HAMH-25',36,30,60,5.15],
    ],
    acc: {
      'Seashell':  ['VE75SEAORD','VE75SEAOSN','VE75SEAOTH','VE75SEAOTM'],
      'Marina':    ['VE75MARORD','VE75MAROSN','VE75MAROTH','VE75MAROTM'],
      'Sandal':    ['VE75SANORD','VE75SANOSN','VE75SANOTH','VE75SANOTM'],
      'Pearl':     ['VE75PEAORD','VE75PEAOSN','VE75PEAOTH','VE75PEAOTM'],
      'White Cap': ['VE75WHIORD','VE75WHIOSN','VE75WHIOTH','VE75WHIOTM'],
      'Dune':      ['VE75DUNORD','VE75DUNOSN','VE75DUNOTH','VE75DUNOTM'],
      'Pier':      ['VE75PIEORD','VE75PIEOSN','VE75PIEOTH','VE75PIEOTM'],
      'Wharf':     ['VE75WHAORD','VE75WHAOSN','VE75WHAOTH','VE75WHAOTM'],
      'Catamaran': ['VE75CATHRD','VE75CATHSN','VE75CATHTH','VE75CATHTM'],
      'Sandbar':   ['VE75SANHRD','VE75SANHSN','VE75SANHTH','VE75SANHTM'],
      'Hampton':   ['VE75HAMHRD','VE75HAMHSN','VE75HAMHTH','VE75HAMHTM'],
      'Maritime':  ['VE75MARWRD','VE75MARWSN','VE75MARWTH','VE75MARWTM'],
      'Mangrove':  ['VE75MANORD','VE75MANOSN','VE75MANOTH','VE75MANOTM'],
    },
  },
  // ─── 14. Courtier (SPC) ───
  {
    name: 'Courtier', cat: 'lvp',
    desc: 'Rigid EZ LOCK, 5.5mm, Side Painted Bevel, 20Mil Surface Guardian Pro, UV/Waterproof Ceramic Bead Finish',
    size: '9" x 59" x 5.5mm',
    accTypes: ['reducer','stairNose','tMold'], // no threshold for SPC
    colors: [
      ['Oak','Admiral','COADM9O5MM-19',29.06,60,49.8,2.49],
      ['Oak','Camarilla','COCAM9O5MM-19',29.06,60,49.8,2.49],
      ['Oak','Chancellor','COCHA9O5MM-19',29.06,60,49.8,2.49],
      ['Oak','Falconer','COFAL9O5MM-19',29.06,60,49.8,2.49],
      ['Oak','Kingsguard','COKIN9O5MM-19',29.06,60,49.8,2.49],
      ['Oak','Rohan','COROH9O5MM-19',29.06,60,49.8,2.49],
      ['Oak','Briar','COBRI9O5MM',29.06,60,49.8,2.49],
      ['Oak','Canterbury','COCAN9O5MM',29.06,60,49.8,2.49],
      ['Oak','Charlemagne','COCHR9O5MM',29.06,60,49.8,2.49],
      ['Oak','Durham','CODUR9O5MM',29.06,60,49.8,2.49],
      ['Oak','Ghent','COGHE9O5MM',29.06,60,49.8,2.49],
      ['Oak','Griffith','COGRI9O5MM',29.06,60,49.8,2.49],
      ['Oak','Knight','COKNI9O5MM',29.06,60,49.8,2.49],
      ['Oak','Nightcastle','CONIG9O5MM',29.06,60,49.8,2.49],
      ['Maple','Clyde','COCLY9M5MM',29.06,60,49.8,2.49],
      ['Hickory','Galloway','COCAL9H5MM',29.06,60,49.8,2.49],
    ],
    acc: {
      'Admiral':     ['COADM9O5MM-19RD','COADM9O5MMFSN','COADM9O5MM-19TM'],
      'Camarilla':   ['COCAM9O5MM-19RD','COCAM9O5MMFSN','COCAM9O5MM-19TM'],
      'Chancellor':  ['COCHA9O5MM-19RD','COCHA9O5MMFSN','COCHA9O5MM-19TM'],
      'Falconer':    ['COFAL9O5MM-19RD','COFAL9O5MMFSN','COFAL9O5MM-19TM'],
      'Kingsguard':  ['COKIN9O5MM-19RD','COKIN9O5MMFSN','COKIN9O5MM-19TM'],
      'Rohan':       ['COROH9O5MM-19RD','COROH9O5MMFSN','COROH9O5MM-19TM'],
      'Briar':       ['COBRI9O5MMRD','COBRI9O5MMFSN','COBRI9O5MMTM'],
      'Canterbury':  ['COCAN9O5MMRD','COCAN9O5MMFSN','COCAN9O5MMTM'],
      'Charlemagne': ['COCHR9O5MMRD','COCHR9O5MMFSN','COCHR9O5MMTM'],
      'Durham':      ['CODUR9O5MMRD','CODUR9O5MMFSN','CODUR9O5MMTM'],
      'Ghent':       ['COGHE9O5MMRD','COGHE9O5MMFSN','COGHE9O5MMTM'],
      'Griffith':    ['COGRI9O5MMRD','COGRI9O5MMFSN','COGRI9O5MMTM'],
      'Knight':      ['COKNI9O5MMRD','COKNI9O5MMFSN','COKNI9O5MMTM'],
      'Nightcastle': ['CONIG9O5MMRD','CONIG9O5MMFSN','CONIG9O5MMTM'],
      'Clyde':       ['COCLY9M5MMRD','COCLY9M5MMFSN','COCLY9M5MMTM'],
      'Galloway':    ['COCAL9H5MMRD','COCAL9H5MMFSN','COCAL9H5MMTM'],
    },
  },
];

// ══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ══════════════════════════════════════════════════════════════

function normalizeForMatch(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function fetchHtml(url) {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) return null;
    return resp.text();
  } catch { return null; }
}

async function getProductUrlsFromSitemap() {
  const html = await fetchHtml(`${BASE_URL}/product-sitemap.xml`);
  if (!html) return [];
  const urls = [];
  const regex = /<loc>(https?:\/\/hallmarkfloors\.com\/product\/[^<]+)<\/loc>/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    urls.push(m[1].replace(/\/$/, '') + '/');
  }
  return urls;
}

function extractImageFromHtml(html) {
  // Strategy 1: JSON-LD
  const jsonLdRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = jsonLdRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1]);
      const img = data.image || data.thumbnailUrl;
      if (img) {
        const src = typeof img === 'string' ? img : (Array.isArray(img) ? img[0] : img.url);
        if (src && src.includes('wp-content/uploads') && !src.includes('logo')) return src;
      }
      if (data['@graph']) {
        for (const node of data['@graph']) {
          const nodeImg = node.image || node.thumbnailUrl;
          if (nodeImg) {
            const src = typeof nodeImg === 'string' ? nodeImg : (Array.isArray(nodeImg) ? nodeImg[0] : nodeImg.url);
            if (src && src.includes('wp-content/uploads') && !src.includes('logo')) return src;
          }
        }
      }
    } catch (_) {}
  }
  // Strategy 2: og:image
  const ogMatch = /<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i.exec(html);
  if (ogMatch && ogMatch[1].includes('wp-content/uploads') && !ogMatch[1].includes('logo')) return ogMatch[1];
  // Strategy 3: WooCommerce data-large_image
  const wcMatch = /data-large_image="([^"]+)"/i.exec(html);
  if (wcMatch && wcMatch[1].includes('wp-content/uploads')) return wcMatch[1];
  // Strategy 4: first product-like image
  const imgRegex = /(?:src|href)="(https?:\/\/hallmarkfloors\.com\/wp-content\/uploads\/[^"]+\.(?:jpg|jpeg|png|webp))"/gi;
  while ((m = imgRegex.exec(html)) !== null) {
    if (!m[1].includes('logo') && !m[1].includes('icon') && !m[1].includes('favicon')) {
      return m[1].replace(/-\d+x\d+(\.[a-zA-Z]+)$/, '$1');
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// CLEANUP — delete all existing Hallmark data
// ══════════════════════════════════════════════════════════════

async function cleanupOldData(client, vendorId) {
  console.log('=== Cleaning up old Hallmark data ===');
  const prodIds = await client.query(
    'SELECT id FROM products WHERE vendor_id = $1', [vendorId]
  );
  if (!prodIds.rows.length) { console.log('  No existing data to clean.\n'); return; }

  const ids = prodIds.rows.map(r => r.id);
  // Delete in dependency order
  await client.query('DELETE FROM media_assets WHERE product_id = ANY($1)', [ids]);
  const skuIds = await client.query('SELECT id FROM skus WHERE product_id = ANY($1)', [ids]);
  if (skuIds.rows.length) {
    const sids = skuIds.rows.map(r => r.id);
    await client.query('DELETE FROM sku_attributes WHERE sku_id = ANY($1)', [sids]);
    await client.query('DELETE FROM packaging WHERE sku_id = ANY($1)', [sids]);
    await client.query('DELETE FROM pricing WHERE sku_id = ANY($1)', [sids]);
    await client.query('DELETE FROM cart_items WHERE sku_id = ANY($1)', [sids]);
  }
  await client.query('DELETE FROM skus WHERE product_id = ANY($1)', [ids]);
  await client.query('DELETE FROM products WHERE id = ANY($1)', [ids]);
  console.log(`  Deleted ${ids.length} products, ${skuIds.rows.length} SKUs\n`);
}

// ══════════════════════════════════════════════════════════════
// MAIN IMPORT
// ══════════════════════════════════════════════════════════════

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Upsert vendor
    const vendorRes = await client.query(`
      INSERT INTO vendors (id, name, code, website)
      VALUES (gen_random_uuid(), 'Hallmark Floors', 'HALLMARK', 'https://hallmarkfloors.com')
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, website = EXCLUDED.website
      RETURNING id
    `);
    const vendorId = vendorRes.rows[0].id;
    console.log(`Vendor: Hallmark Floors (${vendorId})\n`);

    // Clean up old data
    await cleanupOldData(client, vendorId);

    let totalProducts = 0, totalFloorSkus = 0, totalAccSkus = 0;
    // Track all created SKU IDs keyed by internal_sku for image matching later
    const skuMap = new Map(); // colorKey → { skuId, productId }

    console.log('=== Importing collections ===');
    for (const col of COLLECTIONS) {
      const accTypes = col.accTypes || ['reducer', 'stairNose', 'threshold', 'tMold'];
      const accLabels = { reducer: 'Reducer', stairNose: 'Stair Nose', threshold: 'Threshold', tMold: 'T-Mold' };

      // Upsert product (one per collection)
      const { id: productId } = await upsertProduct(client, {
        vendor_id: vendorId,
        name: col.name,
        collection: col.name,
        category_id: CAT[col.cat],
        description_short: col.desc,
      });
      totalProducts++;

      let colFloor = 0, colAcc = 0;

      for (const colorRow of col.colors) {
        const [species, color, sku, sfCtn, boxPlt, lbsCtn, costSqft] = colorRow;
        const finish = colorRow[7] || null; // Serenity has finish in position 7

        const internalSku = 'HALLMARK-' + sku;
        const variantName = color;

        // Upsert flooring SKU
        const { id: skuId } = await upsertSku(client, {
          product_id: productId,
          vendor_sku: sku,
          internal_sku: internalSku,
          variant_name: variantName,
          sell_by: 'box',
        });
        colFloor++;

        // Pricing
        await upsertPricing(client, skuId, {
          cost: costSqft,
          retail_price: costSqft * MARKUP,
          price_basis: 'per_sqft',
        });

        // Packaging
        await upsertPackaging(client, skuId, {
          sqft_per_box: sfCtn,
          boxes_per_pallet: boxPlt,
          weight_per_box_lbs: lbsCtn,
        });

        // Attributes
        await upsertSkuAttribute(client, skuId, 'color', color);
        await upsertSkuAttribute(client, skuId, 'species', species);
        await upsertSkuAttribute(client, skuId, 'size', col.size);
        if (finish) await upsertSkuAttribute(client, skuId, 'finish', finish);

        // Track for image matching
        skuMap.set(`${col.name}::${color}`, { skuId, productId });

        // ── Accessories ──
        // Try color-keyed acc first, then vendor-sku-keyed accBySku
        const accSkus = col.acc?.[color] || col.accBySku?.[sku];
        if (accSkus) {
          for (let i = 0; i < accTypes.length; i++) {
            const accType = accTypes[i];
            const accVendorSku = accSkus[i];
            if (!accVendorSku) continue;
            const accInternal = 'HALLMARK-' + accVendorSku;
            const accLabel = accLabels[accType];
            const accCost = ACC_PRICES[accType];

            const { id: accSkuId } = await upsertSku(client, {
              product_id: productId,
              vendor_sku: accVendorSku,
              internal_sku: accInternal,
              variant_name: `${color} ${accLabel}`,
              sell_by: 'unit',
              variant_type: 'accessory',
            });
            colAcc++;

            await upsertPricing(client, accSkuId, {
              cost: accCost,
              retail_price: accCost * MARKUP,
              price_basis: 'per_unit',
            });
          }
        }
      }

      totalFloorSkus += colFloor;
      totalAccSkus += colAcc;
      console.log(`  ${col.name}: ${colFloor} colors + ${colAcc} accessories`);
    }

    // Set all Hallmark products to active
    await client.query(
      "UPDATE products SET status = 'active' WHERE vendor_id = $1 AND status = 'draft'",
      [vendorId]
    );

    // Populate sku_accessories junction table (links flooring SKUs → their accessories)
    const accLinksRes = await client.query(`
      INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
      SELECT floor.id, acc.id,
        CASE
          WHEN acc.variant_name LIKE '% Reducer' THEN 1
          WHEN acc.variant_name LIKE '% Stair Nose' THEN 2
          WHEN acc.variant_name LIKE '% Threshold' THEN 3
          WHEN acc.variant_name LIKE '% T-Mold' THEN 4
          ELSE 5
        END
      FROM skus floor
      JOIN skus acc ON acc.product_id = floor.product_id
        AND acc.variant_type = 'accessory'
        AND acc.variant_name LIKE floor.variant_name || ' %'
      JOIN products p ON p.id = floor.product_id
      WHERE p.vendor_id = $1 AND floor.variant_type IS NULL
      ON CONFLICT DO NOTHING
    `, [vendorId]);
    console.log(`Accessory links created: ${accLinksRes.rowCount}`);

    await client.query('COMMIT');
    console.log(`\n=== Import Complete ===`);
    console.log(`Products: ${totalProducts}`);
    console.log(`Flooring SKUs: ${totalFloorSkus}`);
    console.log(`Accessory SKUs: ${totalAccSkus}`);
    console.log(`Total SKUs: ${totalFloorSkus + totalAccSkus}\n`);

    // ══════════════════════════════════════════════════════════
    // IMAGE SCRAPING (outside transaction — non-critical)
    // ══════════════════════════════════════════════════════════
    console.log('=== Scraping product images from hallmarkfloors.com ===');

    const productUrls = await getProductUrlsFromSitemap();
    console.log(`Found ${productUrls.length} product URLs in sitemap\n`);

    // Build a normalized lookup: slug → color+collection for matching
    const colorLookup = new Map();
    for (const col of COLLECTIONS) {
      for (const [species, color] of col.colors) {
        const normColor = normalizeForMatch(color);
        const normSpecies = normalizeForMatch(species);
        // Multiple match keys for flexibility
        const keys = [
          normColor,
          normColor + normSpecies,
          normColor + normalizeForMatch(col.name),
        ];
        for (const key of keys) {
          if (!colorLookup.has(key)) {
            colorLookup.set(key, { collection: col.name, color });
          }
        }
      }
    }

    let imagesScraped = 0;
    const matchedColors = new Set();

    for (const url of productUrls) {
      const slug = url.replace(/\/+$/, '').split('/').pop() || '';
      const cleanSlug = slug
        .replace(/-hardwood-hallmark-floors$/, '')
        .replace(/-hardwood$/, '')
        .replace(/-engineered$/, '')
        .replace(/-hallmark$/, '')
        .replace(/-flooring$/, '')
        .replace(/-floors$/, '');
      const normSlug = normalizeForMatch(cleanSlug);

      // Try to match to a price list color
      let match = null;
      for (const [key, val] of colorLookup) {
        if (key.length >= 4 && (normSlug.includes(key) || key.includes(normSlug))) {
          const mapKey = `${val.collection}::${val.color}`;
          if (!matchedColors.has(mapKey) && skuMap.has(mapKey)) {
            match = val;
            break;
          }
        }
      }

      if (!match) continue;
      const mapKey = `${match.collection}::${match.color}`;
      if (matchedColors.has(mapKey)) continue;

      const html = await fetchHtml(url);
      if (!html) { await delay(500); continue; }

      const imgUrl = extractImageFromHtml(html);
      if (!imgUrl) { await delay(300); continue; }

      const { skuId, productId } = skuMap.get(mapKey);
      await saveSkuImages(pool, productId, skuId, [imgUrl], { maxImages: 1 });
      matchedColors.add(mapKey);
      imagesScraped++;

      if (imagesScraped % 20 === 0) console.log(`  ... ${imagesScraped} images saved`);
      await delay(800);
    }

    console.log(`\n=== Image Scrape Complete ===`);
    console.log(`Images saved: ${imagesScraped}`);
    console.log(`Colors without images: ${skuMap.size - matchedColors.size}`);

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
