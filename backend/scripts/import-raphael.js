#!/usr/bin/env node
/**
 * Import Raphael Stone Collection — Quartz Slabs + Porcelain Tiles
 *
 * Source: Diamond Price List Q2-2025
 * Two product lines:
 *   1. Quartz/Natural Stone slabs (raphaelstoneusa.com)
 *   2. Porcelain tiles & pavers (raphaelp.com)
 *
 * Usage: docker compose exec api node scripts/import-raphael.js
 */
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const CAT = {
  quartz:    '650e8400-e29b-41d4-a716-446655440041',
  quartzite: '650e8400-e29b-41d4-a716-446655440044',
  marble:    '650e8400-e29b-41d4-a716-446655440043',
  porcelain: '650e8400-e29b-41d4-a716-446655440012',
  pavers:    '650e8400-e29b-41d4-a716-446655440062',
};

function slugify(n) {
  return n.toLowerCase().replace(/[''()]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function titleCase(s) {
  return s.replace(/\b\w/g, c => c.toUpperCase());
}

// ==================== QUARTZ SLAB DATA ====================
// [vendorSku, colorName, sqft, pricePerSlab]
const QUARTZ = [
  // Standard Quartz — 126x64 (56 sqft) unless noted
  ['RQ03015','Galaxy White',56,495],
  ['RQ08011','Explosion White',56,595],
  ['RQ09283','Calacatta Grey',56,595],
  ['RQ09281','Calacatta Borghini',56,595],
  ['RQ09280','Calacatta BNC',56,595],
  ['RQ09945','Cemento Light Leather',56,595],
  ['RQ09947','Cemento Dark Leather',56,595],
  ['RQ09932','Calacatta Florence',56,595],
  ['RQ09303','Venato Classic',56,595],
  ['RQ09913','Venetian Black',56,595],
  ['RQ09301','Calacatta Black',56,695],
  ['RQ09985','Tropicana Gold',56,695],
  ['RQ09997','Silk White',56,695],
  ['RQ09953','Carrara White',57.78,695],   // 130x64
  ['RQ09954','Carrara Gold',57.78,695],     // 130x64
  ['RQ09720','Calacatta Celine',56,695],
  ['RQ09302','Borghini Classic',56,750],
  ['RQ09292','Statuario Classic',56,750],
  ['RQ09293','Alaskan White',56,750],
  ['RQ09800','Portoro Black',56,750],
  ['RQ09947S','Sardinia White',56,795],     // PDF reuses RQ09947
  ['RQ08011-L','Explosion White Leather',56,845],
  ['RQ08011S','Explosion White Super White',56,845], // PDF reuses RQ08011
  ['RQ10034','Cemento White',56,845],
  ['RQ09991','Cemento Light Honed',56,845],
  ['RQ09945H','Cemento Dark Honed',56,845], // PDF reuses RQ09945
  ['RQ09992','Cemento Shell Honed',56,845],
  ['RQ09286','Organic White',56,845],
  ['RQ09976','Ariston White',56,845],
  ['RQ09977','Ariston Gold',56,845],
  ['RQ10024','Absolute Black',56,845],
  ['RQ09924','Calacatta Palermo',56,930],
  ['RQ09972','Venatino White',56,930],
  ['RQ09973','Venatino Gold',56,930],
  ['RQ09876','Mystic Gold',56,930],
  ['RQ09777','Fountain Blue',56,930],
  ['RQ09971','Calacatta Gris',56,930],
  ['RQ09995','Calacatta Gris Gold',56,930],
  ['RQ09140','Calacatta Solange Honed',56,930],
  ['RQ09919','Venetian Bronze',56,930],
  ['RQ09942','Borghini Silver',56,930],
  ['RQ09957','Calacatta Gold Ultra',56,930],
  ['RQ09600','Nero Marquina',56,1015],
  ['RQ09938','Calacatta Mila',56,1015],
  ['RQ09988','Jade Black',56,1015],
  ['RQ09713','Calacatta Nero',56,1015],
  ['RQ09962','Panda Black',56,1015],
  ['RQ09962L','Panda Black Leather',56,1015],
  ['RQ09978','Calacatta Naple',56,1015],
  ['RQ09975','Calacatta Luo',56,1015],
  ['RQ09897','Calacatta Pyrenees',56,1015],
  ['RQ09898','Calacatta Venetian',56,1015],
  ['RQ09916','Blanco Perla',56,1015],
  ['RQ09987','Jade Gold',56,1100],
  ['RQ09918','Fountain Gold',56,1100],
  ['RQ09896','San Laurent',56,1100],
  ['RQ09986','Monaco Grey',56,1100],
  ['RQ09896M','Calacatta Monaco',56,1100],  // PDF reuses RQ09896
  ['RQ09911','Calacatta Ana',56,1100],
  ['RQ09893','Calacatta Arabescato',56,1100],
  ['RQ09910','Calacatta Romano',56,1100],
  ['RQ09921','Calacatta Capria',56,1100],
  ['RQ09986S','Calacatta Statuario',56,1100], // PDF reuses RQ09986
];

// Printed Quartz — 126x64 (56 sqft), all $1,100.75
const PRINTED = [
  ['RQ10014','Calacatta Caldia'],['RQ10015','Calacatta Lincoln'],
  ['RQ10016','Calacatta Italia'],['RQ10017','Calacatta Zembrino'],
  ['RQ10019','Super White'],['RQ10020','Borghini Extra'],
  ['RQ10026','Armani Gold'],['RQ10027','Taj Mahal Polish'],
  ['RQ10026L','Taj Mahal Leather'],
];

// Mineral Collection — Semi Precious Stone — 120x57 (47.50 sqft)
const MINERAL = [
  ['RQ00500','Crystal Quartz',7500],['RQ00800','White Agate',7500],
  ['RQ00900','Pink Quartz',7500],['RQ00600','Grey Agate',7500],
  ['RQ00400','Smoky Quartz',7500],['RQ00300','Blue Agate',7500],
  ['RQ00200','Golden Quartz',7500],['RQ0110','Green Agate',7500],
  ['RQ00100','Amethyst',7500],['RQ01000','Black Agate',8500],
  ['RQ00700','Petrified Wood',8500],
];

// Natural Stone — Quartzite (various sizes)
// [vendorSku, colorName, sqft, pricePerSlab]
const QUARTZITE = [
  ['RQZ6023','Cristallo',56.39,2550],['RQZ6075','Cristallo Silver',65.26,2550],
  ['RQZ6060','Le Blanc',63.63,2380],['RQZ6069','Venus White',47.79,2380],
  ['RQZ6014','Perla Venata',69.51,2210],['RQZ6007','Matarazzo',70.00,2210],
  ['RQZ6017','Taj Mahal',70.05,2210],['RQZ6017-L','Taj Mahal Leather',70.05,2210],
  ['RQZ6071','Taj Mahal Gold',63.10,2210],['RQZ6003','Montebello',70.05,2210],
  ['RQZ6047','Polaris Gold',48.61,2210],['RQZ6073','Invictus White',66.84,2210],
  ['RQZ6072','Artemis',62.86,2210],['RQZ6048','White Supreme',67.91,2210],
  ['RQZ6047P','Polaris',45.11,2210],['RQZ6055','Titanium',70.77,2210],
  ['RQZ6059','Titanium Black',66.31,2210],['RQZ6070','Relic',65.25,2210],
  ['RQZ6078','Polaris Grey',59.61,2210],['RQZ6079-L','Naika Leather',70.58,2210],
  ['RQZ6077','Opus White',64.74,2210],['RQZ6057','Maldives',65.77,2040],
];

// Natural Stone — Marble
const MARBLE = [
  ['RMS0042-P','Marquina Polished',66.06,1360],
  ['RMS0042-L','Marquina Leather',64.44,1530],
  ['RMS0042-LG','Marquina Leather Glossy',60.42,1530],
];

// ==================== PORCELAIN DATA ====================
// [code, name, variants[]]
// variant: [size, finish, price, pcsBox, sqftBox, pattern, notes?]
// finish: P=Polish, M=Matte, D=Deco, S=Satin, F=Flamed
// pattern: R=Random, BM=Bookmatch, C=Continuous, S=Solid
const PORCELAIN = [
  ['1001','Panda',[
    ['32x32','P',3.50,3,21.33,'BM'],['32x64','P',4.25,2,28.44,'BM'],
    ['32x64','M',4.25,2,28.44,'BM'],['48x96','P',8.00,1,32,'BM'],
    ['48x96','M',8.00,1,32,'BM'],
  ]],
  ['1003','Statuario',[
    ['32x32','P',3.50,3,21.33,'R'],['32x32','M',3.50,3,21.33,'R'],
    ['32x64','P',4.25,2,28.44,'R'],['32x64','M',4.25,2,28.44,'R'],
    ['48x48','P',4.50,2,32,'R'],['48x48','M',4.50,2,32,'R'],
    ['48x96','M',8.00,1,32,'BM'],['48x96','M',8.00,2,64,'C','6mm'],
    ['48x111','P',9.95,1,37,'C'],['12x12','M',6.00,1,1,'','mosaic'],
  ]],
  ['1004','Sahara Black',[
    ['32x64','P',4.25,2,28.44,'R'],['32x64','M',4.25,2,28.44,'R'],
    ['48x48','P',4.50,2,32,'R'],['48x48','M',4.50,2,32,'R'],
    ['48x96','P',8.00,1,32,'R'],['48x111','M',9.95,1,37,'R'],
  ]],
  ['1007','Armani Grey',[
    ['32x32','P',3.50,3,21.33,'R'],['32x32','M',3.50,3,21.33,'R'],
    ['32x64','P',4.25,2,28.44,'R'],['32x64','M',4.25,2,28.44,'R'],
    ['48x48','P',4.50,2,32,'R'],['48x48','M',4.50,2,32,'R'],
    ['48x96','P',8.00,1,32,'R'],['48x96','M',8.00,1,32,'R'],
    ['12x12','M',6.00,1,1,'','mosaic'],
  ]],
  ['1009','Calacatta Spider',[
    ['48x96','P',8.00,1,32,'BM'],
  ]],
  ['1010','Calacatta Venice',[
    ['32x64','P',4.25,2,28.44,'R'],['32x64','M',4.25,2,28.44,'R'],
    ['32x64','D',4.95,2,28.44,'R'],['48x48','P',4.50,2,32,'R'],
    ['48x48','M',4.50,2,32,'R'],['48x96','P',8.00,1,32,'C'],
    ['48x96','M',8.00,1,32,'C'],['12x12','M',6.00,1,1,'','mosaic'],
  ]],
  ['1012','Armani Crema',[
    ['32x32','P',3.50,3,21.33,'R'],['32x32','M',3.50,3,21.33,'R'],
    ['32x64','P',4.25,2,28.44,'R'],['32x64','M',4.25,2,28.44,'R'],
    ['32x64','D',4.95,2,28.44,'R'],['48x48','P',4.50,2,32,'R'],
    ['48x48','M',4.50,2,32,'R'],['48x96','P',8.00,1,32,'R'],
    ['48x96','M',8.00,1,32,'R'],['12x12','M',6.00,1,1,'','mosaic'],
  ]],
  ['1013','Nero Marquina',[
    ['32x32','P',3.50,3,21.33,'R'],['32x64','P',4.25,2,28.44,'R'],
    ['32x64','M',4.25,2,28.44,'R'],['48x48','P',4.50,2,32,'R'],
    ['48x48','M',4.50,2,32,'R'],['48x111','P',9.95,1,37,'R'],
    ['48x111','M',9.95,1,37,'R'],['12x12','M',6.00,1,1,'','mosaic'],
  ]],
  ['1017','Lea Blanco',[
    ['32x64','P',4.25,2,28.44,'S'],['32x64','M',4.25,2,28.44,'S'],
    ['48x48','P',4.50,2,32,'S'],['48x48','M',4.50,2,32,'S'],
    ['48x96','P',8.00,2,64,'S','6mm'],['48x96','M',8.00,2,64,'S','6mm'],
    ['48x96','P',8.00,1,32,'S'],['12x12','M',6.00,1,1,'','mosaic'],
  ]],
  ['1018','Pietra Blanco',[
    ['32x64','P',4.25,2,28.44,'R'],['32x64','M',4.25,2,28.44,'R'],
    ['32x64','D',4.95,2,28.44,'R'],['48x48','P',4.50,2,32,'R'],
    ['48x48','M',4.50,2,32,'R'],['48x96','P',8.00,1,32,'C'],
    ['48x96','M',8.00,1,32,'C'],['12x12','M',6.00,1,1,'','mosaic'],
  ]],
  ['1019','Calacatta Crema',[
    ['32x32','P',3.50,3,21.33,'R'],['32x32','M',3.50,3,21.33,'R'],
    ['32x64','P',4.25,2,28.44,'R'],['48x48','P',4.50,2,32,'R'],
  ]],
  ['1022','Vintage Almendra',[
    ['32x64','M',4.25,2,28.44,'R'],['48x48','M',4.50,2,32,'R'],
  ]],
  ['1027','Statuario Classico',[
    ['48x48','M',4.50,2,32,'R'],['48x48','P',4.50,2,32,'R'],
    ['48x96','P',8.00,1,32,'BM'],['12x12','M',6.00,1,1,'','mosaic'],
  ]],
  ['1028','Bianco Dolomiti',[
    ['32x64','P',4.25,2,28.44,'R'],['32x64','M',4.25,2,28.44,'R'],
    ['48x48','P',4.50,2,32,'R'],['48x48','M',4.50,2,32,'R'],
    ['48x96','P',8.00,1,32,'R'],['48x96','M',8.00,1,32,'R'],
    ['12x12','M',6.00,1,1,'','mosaic'],
  ]],
  ['1029','Blue Agate Onyx',[
    ['32x64','P',4.25,2,28.44,'R'],
  ]],
  ['1030','Gold Agate Onyx',[
    ['32x32','P',3.50,3,21.33,'R'],['32x32','M',3.50,3,21.33,'R'],
    ['32x64','P',4.25,2,28.44,'R'],['32x64','M',4.25,2,28.44,'R'],
    ['48x48','P',4.50,2,32,'R'],['48x48','M',4.50,2,32,'R'],
    ['48x96','P',8.00,1,32,'BM'],
  ]],
  ['1038','Armani Gris',[
    ['32x64','P',4.25,2,28.44,'R'],['32x64','S',4.25,2,28.44,'R'],
    ['48x96','P',8.00,1,32,'R'],['48x111','P',9.95,1,37,'R'],
    ['48x111','S',9.95,1,37,'R'],['12x12','M',6.00,1,1,'','mosaic'],
  ]],
  ['1047','Calacatta Italia',[
    ['32x32','P',3.50,3,21.33,'R'],['32x32','M',3.50,3,21.33,'R'],
    ['32x64','P',4.25,2,28.44,'BM'],['32x64','M',4.25,2,28.44,'BM'],
    ['48x96','P',8.00,1,32,'BM'],['48x96','M',8.00,1,32,'BM'],
  ]],
  ['1048','Fire Black',[
    ['32x32','P',4.25,3,21.33,'BM'],['32x32','M',4.25,3,21.33,'BM'],
  ]],
  ['1054','Bardiglio',[
    ['48x96','P',8.00,1,32,'BM'],
  ]],
  ['1066','Trianglo Grigio',[
    ['32x32','P',4.25,3,21.33,'BM'],
  ]],
  ['1071','Calacatta Borghini',[
    ['32x32','M',3.50,3,21.33,'R'],['32x32','P',3.50,3,21.33,'R'],
    ['48x96','M',8.00,1,32,'R'],
  ]],
  ['1072','Calacatta Udi',[
    ['32x32','P',3.50,3,21.33,'R'],['32x64','P',4.25,2,28.44,'R'],
    ['32x64','M',4.25,2,28.44,'R'],['32x64','D',4.95,2,28.44,'R'],
    ['48x48','P',4.50,2,32,'R'],['48x48','M',4.50,2,32,'R'],
    ['48x96','P',8.00,1,32,'C'],['48x111','P',9.95,1,37,'C'],
    ['48x111','M',9.95,1,37,'C'],
  ]],
  ['1079','Agate Grey',[
    ['48x96','P',8.00,1,32,'BM'],
  ]],
  ['1080','Agate White',[
    ['32x32','P',3.50,3,21.33,'R'],['32x32','M',3.50,3,21.33,'R'],
    ['32x64','P',4.25,2,28.44,'R'],['32x64','M',4.25,2,28.44,'R'],
    ['48x48','P',4.50,2,32,'R'],['48x48','M',4.50,2,32,'R'],
    ['48x96','P',8.00,1,32,'BM'],
  ]],
  ['1082','Calacatta Aline',[
    ['32x64','P',4.25,2,28.44,'R'],['48x48','P',4.50,2,32,'R'],
    ['48x96','P',8.00,1,32,'C'],['12x12','M',6.00,1,1,'','mosaic'],
  ]],
  ['1083','Cristallo Grey',[
    ['32x64','M',4.25,2,28.44,'R'],['32x64','D',4.95,2,28.44,'R'],
    ['48x48','M',4.50,2,32,'R'],
  ]],
  ['1084','Blue Storm Onyx',[
    ['48x96','P',8.00,1,32,'BM'],
  ]],
  ['1087','Grafito',[
    ['32x64','M',4.25,2,28.44,'R'],['48x48','M',4.50,2,32,'R'],
  ]],
  ['1088','Concreto',[
    ['32x32','M',3.50,3,21.33,'R'],['32x64','M',4.25,2,28.44,'R'],
    ['32x64','D',4.95,2,28.44,'R'],['48x48','M',4.50,2,32,'R'],
  ]],
  ['1104','Statuario Gold',[
    ['32x32','P',3.50,3,21.33,'R'],['32x32','M',3.50,3,21.33,'R'],
    ['32x64','P',4.25,2,28.44,'R'],['48x48','P',4.50,2,32,'R'],
  ]],
  ['1106','Nordic Grey',[
    ['32x64','M',4.25,2,28.44,'R'],['48x48','M',4.50,2,32,'R'],
  ]],
  ['1107','Nero Basaltina',[
    ['32x64','M',4.25,2,28.44,'R'],['48x48','M',4.50,2,32,'R'],
  ]],
  ['1108','Bianco Basaltina',[
    ['32x64','M',4.25,2,28.44,'R'],['48x48','M',4.50,2,32,'R'],
  ]],
  ['1110','Graphite',[
    ['32x64','M',4.25,2,28.44,'R'],['32x64','D',4.95,2,28.44,'R'],
    ['48x48','M',4.50,2,32,'R'],
  ]],
  ['1118','Dilengo Light',[['32x64','D',4.95,2,28.44,'R']]],
  ['1120','Dilengo Crema',[['32x64','D',4.95,2,28.44,'R']]],
  ['1121','Dilengo Bianco',[['32x64','D',4.95,2,28.44,'R']]],
  ['1122','Calacatta SV',[
    ['32x64','P',4.25,2,28.44,'R'],['32x64','M',4.25,2,28.44,'R'],
    ['48x48','P',4.50,2,32,'R'],
  ]],
  ['1124','Venezuela Dark',[
    ['32x64','M',2.99,2,28.44,'R'],['48x48','M',2.99,2,32,'R'],
  ]],
  ['1125','Venezuela Light',[
    ['32x64','M',2.99,2,28.44,'R'],['48x48','M',2.99,2,32,'R'],
  ]],
  ['1128','Cemento Ivory',[
    ['32x32','M',3.50,3,21.33,'R'],['32x64','M',4.25,2,28.44,'R'],
    ['32x64','D',4.95,2,28.44,'R'],['48x48','M',4.50,2,32,'R'],
  ]],
  ['1136','Panda Bianco',[['48x96','P',8.00,1,32,'BM']]],
  ['1137','Titanium Brown',[['48x96','P',8.00,1,32,'BM']]],
  ['1221','Concreto Light Grey',[['48x48','M',4.50,2,32,'R']]],
  ['1233','Rosal White',[['48x48','M',4.50,2,32,'R']]],
  ['1234','Rosal Crema',[['48x48','M',4.50,2,32,'R']]],
  ['1235','Rosal Grey',[['48x48','M',4.50,2,32,'R']]],
  ['1236','Travertino Grey',[
    ['32x64','M',4.25,2,28.44,'R'],['48x48','M',4.50,2,32,'R'],
    ['48x111','M',9.95,1,37,'R'],
  ]],
  ['1237','Travertino Crema',[
    ['32x64','M',4.25,2,28.44,'R'],['48x48','M',4.50,2,32,'R'],
    ['48x111','M',9.95,1,37,'R'],
  ]],
  ['1238','Travertino White',[
    ['32x64','M',4.25,2,28.44,'R'],['48x48','M',4.50,2,32,'R'],
    ['48x111','M',9.95,1,37,'R'],
  ]],
  // Additional items from last page
  ['1005','Rock Ice',[
    ['32x32','M',1.95,3,21.33,'R'],['32x64','M',2.25,2,28.44,'R'],
  ]],
  ['1006','Rock Grey',[
    ['32x64','M',2.25,2,28.44,'R'],['48x48','M',2.50,2,32,'R'],
  ]],
  ['1011','Diamante Combo',[['48x96','P',8.00,2,64,'BM','6mm']]],
  ['1014','Amonite Bianco',[
    ['32x32','M',1.95,3,21.33,'R'],['48x48','M',2.50,2,32,'R'],
  ]],
  ['1020','Rigato White',[
    ['32x32','M',1.95,3,21.33,'R'],['32x64','M',2.25,2,28.44,'R'],
    ['48x48','P',2.50,2,32,'R'],
  ]],
  ['1021','Calacatta Gris Tile',[
    ['32x32','M',1.95,3,21.33,'BM'],['32x32','P',1.95,3,21.33,'BM'],
    ['32x64','M',2.25,2,28.44,'R'],['48x96','M',8.00,2,64,'C','6mm'],
    ['48x96','P',8.00,2,64,'C','6mm'],
  ]],
  ['1023','Travertino Beige',[
    ['32x64','M',2.25,2,28.44,'R'],['48x48','M',2.50,2,32,'R'],
    ['48x96','M',8.00,2,64,'R','6mm'],
  ]],
  ['1025','Linear Nero',[
    ['32x32','M',1.95,3,21.33,'R'],['32x64','M',2.25,2,28.44,'R'],
    ['48x48','M',2.50,2,32,'R'],
  ]],
  ['1032','Calacatta Vintage',[
    ['32x32','M',1.95,3,21.33,'R'],['32x32','P',1.95,3,21.33,'R'],
    ['32x64','M',2.25,2,28.44,'R'],['48x96','P',8.00,2,64,'R','6mm'],
  ]],
  ['1034','Onice White',[
    ['48x48','P',2.50,2,32,'BM'],['48x96','P',8.00,2,64,'BM','6mm'],
  ]],
  ['1039','Uni Color Dark Grey',[['32x64','M',2.25,2,28.44,'R']]],
  ['1040','Uni Color Light Grey',[['32x32','M',1.95,3,21.33,'R']]],
  ['1046','Opera Azul',[['48x96','P',8.00,2,64,'R','6mm']]],
  ['1062','Calacatta Gold Tile',[
    ['32x64','M',2.25,2,28.44,'R'],['32x64','P',2.25,2,28.44,'R'],
  ]],
  ['1073','Calacatta Blue',[['32x32','P',1.95,3,21.33,'R']]],
];

// Pavers (20mm) — all FLAMED finish
// [code, name, size, pcsBox, sqftBox]
const PAVERS = [
  ['2001','Limestone Ash','24x24',2,8],['2002','Limestone Beige','24x24',2,8],
  ['2003','Limestone Ice','24x24',2,8],['2004','Limestone Coal','24x24',2,8],
  ['2007','Durango Medium','24x24',2,8],['2009','Technika Grigio','24x24',2,8],
  ['2014','Moroccan Arabisch','24x24',2,8],['2015','Moroccan Lillie','24x24',2,8],
  ['2016','Moroccan Geometrisch','24x24',2,8],['2017','Moroccan Blumen','24x24',2,8],
  ['2018','Limestone Gunmetal','24x24',2,8],['2028','Rexstone Black','24x24',2,8],
  ['2031','Ultra Solid Black','24x24',2,8],['2032','Ultra Solid Light Grey','24x24',2,8],
  ['2034','Ultra Solid Beige','24x24',2,8],['2035','Terrazzo Black','24x24',2,8],
  ['2005','Fjord Honning','16x48',2,10.66],['2006','Fjord Gra','16x48',2,10.66],
  ['2011','Endless Bone','18x36',2,9],['2012','Endless Silver','18x36',2,9],
  ['2013','Endless White','18x36',2,9],
  ['2019','Colosseo Beige','36x36',1,9],['2020','Colosseo Grigio','36x36',1,9],
  ['2024','Caementum Clarus','36x36',1,9],['2025','Caementum Griseo','36x36',1,9],
  ['2021','Forest Dark Grey','16x32',2,7.1],
  ['2029','Ultra Essenze Gelsomino','16x32',2,7.1],
  ['2030','Ultra Essenze Vaniglia','16x32',2,7.1],
  ['2026','Tribeca Beige','24x48',1,8],['2027','Tribeca Grey','24x48',1,8],
  ['2036','Crema Marfil','24x36',1,6],
];

// ==================== DB HELPERS ====================
async function upsertProduct(vendorId, categoryId, name, collection) {
  const r = await pool.query(`
    INSERT INTO products (vendor_id, category_id, name, collection, status)
    VALUES ($1, $2, $3, $4, 'active')
    ON CONFLICT (vendor_id, collection, name) DO UPDATE SET
      category_id = EXCLUDED.category_id, updated_at = CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [vendorId, categoryId, name, collection]);
  return r.rows[0];
}

async function upsertSku(productId, vendorSku, internalSku, variantName, sellBy) {
  const r = await pool.query(`
    INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (internal_sku) DO UPDATE SET
      product_id = EXCLUDED.product_id,
      vendor_sku = EXCLUDED.vendor_sku,
      variant_name = EXCLUDED.variant_name,
      sell_by = EXCLUDED.sell_by,
      updated_at = CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [productId, vendorSku, internalSku, variantName, sellBy]);
  return r.rows[0];
}

async function upsertPricing(skuId, cost, retail, basis) {
  await pool.query(`
    INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (sku_id) DO UPDATE SET
      cost = EXCLUDED.cost, retail_price = EXCLUDED.retail_price,
      price_basis = EXCLUDED.price_basis
  `, [skuId, cost, retail, basis]);
}

async function upsertPackaging(skuId, sqftBox, pcsBox) {
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box)
    VALUES ($1, $2, $3)
    ON CONFLICT (sku_id) DO UPDATE SET
      sqft_per_box = EXCLUDED.sqft_per_box, pieces_per_box = EXCLUDED.pieces_per_box
  `, [skuId, sqftBox, pcsBox]);
}

const FINISH_MAP = { P: 'Polish', M: 'Matte', D: 'Deco', S: 'Satin', F: 'Flamed' };

// ==================== MAIN ====================
async function main() {
  // Create vendor
  const vRes = await pool.query(`
    INSERT INTO vendors (code, name, website)
    VALUES ('RAPHAEL', 'Raphael Stone Collection', 'https://www.raphaelstoneusa.com')
    ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `);
  const vendorId = vRes.rows[0].id;
  console.log(`Vendor: Raphael Stone Collection (${vendorId})\n`);

  let prodCreated = 0, prodUpdated = 0, skuCreated = 0, skuUpdated = 0;

  // ---- STANDARD QUARTZ ----
  console.log('=== Standard Quartz Slabs ===');
  for (const [vsku, name, sqft, slabPrice] of QUARTZ) {
    const prod = await upsertProduct(vendorId, CAT.quartz, name, 'Quartz Surfaces');
    if (prod.is_new) prodCreated++; else prodUpdated++;
    const retailSqft = parseFloat((slabPrice / sqft).toFixed(2));
    const costSqft = parseFloat((retailSqft / 2).toFixed(2));
    const isku = `RAPHAEL-Q-${slugify(name)}`;
    const sku = await upsertSku(prod.id, vsku, isku, `${name} Slab 2cm`, 'sqft');
    if (sku.is_new) skuCreated++; else skuUpdated++;
    await upsertPricing(sku.id, costSqft, retailSqft, 'per_sqft');
    await upsertPackaging(sku.id, sqft, 1);
  }
  console.log(`  ${QUARTZ.length} colors processed`);

  // ---- PRINTED QUARTZ ----
  console.log('=== Printed Quartz ===');
  for (const [vsku, name] of PRINTED) {
    const prod = await upsertProduct(vendorId, CAT.quartz, name, 'Printed Quartz');
    if (prod.is_new) prodCreated++; else prodUpdated++;
    const retailSqft = parseFloat((1100.75 / 56).toFixed(2));
    const costSqft = parseFloat((retailSqft / 2).toFixed(2));
    const isku = `RAPHAEL-PQ-${slugify(name)}`;
    const sku = await upsertSku(prod.id, vsku, isku, `${name} Slab 2cm`, 'sqft');
    if (sku.is_new) skuCreated++; else skuUpdated++;
    await upsertPricing(sku.id, costSqft, retailSqft, 'per_sqft');
    await upsertPackaging(sku.id, 56, 1);
  }
  console.log(`  ${PRINTED.length} colors processed`);

  // ---- MINERAL COLLECTION ----
  console.log('=== Mineral Collection (Semi Precious) ===');
  for (const [vsku, name, slabPrice] of MINERAL) {
    const prod = await upsertProduct(vendorId, CAT.quartz, name, 'Mineral Collection');
    if (prod.is_new) prodCreated++; else prodUpdated++;
    const retailSqft = parseFloat((slabPrice / 47.5).toFixed(2));
    const costSqft = parseFloat((retailSqft / 2).toFixed(2));
    const isku = `RAPHAEL-MC-${slugify(name)}`;
    const sku = await upsertSku(prod.id, vsku, isku, `${name} Slab`, 'sqft');
    if (sku.is_new) skuCreated++; else skuUpdated++;
    await upsertPricing(sku.id, costSqft, retailSqft, 'per_sqft');
    await upsertPackaging(sku.id, 47.5, 1);
  }
  console.log(`  ${MINERAL.length} colors processed`);

  // ---- QUARTZITE ----
  console.log('=== Natural Stone — Quartzite ===');
  for (const [vsku, name, sqft, slabPrice] of QUARTZITE) {
    const prod = await upsertProduct(vendorId, CAT.quartzite, name, 'Natural Stone');
    if (prod.is_new) prodCreated++; else prodUpdated++;
    const retailSqft = parseFloat((slabPrice / sqft).toFixed(2));
    const costSqft = parseFloat((retailSqft / 2).toFixed(2));
    const isku = `RAPHAEL-NS-${slugify(name)}`;
    const sku = await upsertSku(prod.id, vsku, isku, `${name} Slab`, 'sqft');
    if (sku.is_new) skuCreated++; else skuUpdated++;
    await upsertPricing(sku.id, costSqft, retailSqft, 'per_sqft');
    await upsertPackaging(sku.id, sqft, 1);
  }
  console.log(`  ${QUARTZITE.length} colors processed`);

  // ---- MARBLE ----
  console.log('=== Natural Stone — Marble ===');
  for (const [vsku, name, sqft, slabPrice] of MARBLE) {
    const prod = await upsertProduct(vendorId, CAT.marble, name, 'Natural Stone');
    if (prod.is_new) prodCreated++; else prodUpdated++;
    const retailSqft = parseFloat((slabPrice / sqft).toFixed(2));
    const costSqft = parseFloat((retailSqft / 2).toFixed(2));
    const isku = `RAPHAEL-NS-${slugify(name)}`;
    const sku = await upsertSku(prod.id, vsku, isku, `${name} Slab`, 'sqft');
    if (sku.is_new) skuCreated++; else skuUpdated++;
    await upsertPricing(sku.id, costSqft, retailSqft, 'per_sqft');
    await upsertPackaging(sku.id, sqft, 1);
  }
  console.log(`  ${MARBLE.length} colors processed`);

  // ---- PORCELAIN TILES ----
  console.log('\n=== Porcelain Tiles ===');
  for (const [code, name, variants] of PORCELAIN) {
    const prod = await upsertProduct(vendorId, CAT.porcelain, name, 'Porcelain Tiles');
    if (prod.is_new) prodCreated++; else prodUpdated++;

    for (const v of variants) {
      const [size, fin, price, pcsBox, sqftBox, pattern, notes] = v;
      const finName = FINISH_MAP[fin] || fin;
      const is6mm = notes === '6mm';
      const isMosaic = notes === 'mosaic';

      const vendorSku = isMosaic ? `RP3${code.slice(1)}` : `RP${code}`;
      const suffix = is6mm ? '-6MM' : (isMosaic ? '-MOS' : '');
      const internalSku = `RAPHAEL-RP${code}-${size.replace('x', '')}-${fin}${suffix}`;

      let variantName = `${size} ${finName}`;
      if (is6mm) variantName += ' (6mm)';
      if (isMosaic) variantName = `12x12 Mosaic`;

      const sku = await upsertSku(prod.id, vendorSku, internalSku, variantName, 'sqft');
      if (sku.is_new) skuCreated++; else skuUpdated++;

      const cost = parseFloat((price / 2).toFixed(2));
      await upsertPricing(sku.id, cost, price, 'per_sqft');
      await upsertPackaging(sku.id, sqftBox, pcsBox);
    }
    console.log(`  ${name} (${code}) — ${variants.length} SKUs`);
  }

  // ---- PAVERS ----
  console.log('\n=== Porcelain Pavers (20mm) ===');
  for (const [code, name, size, pcsBox, sqftBox] of PAVERS) {
    const prod = await upsertProduct(vendorId, CAT.pavers, name, 'Porcelain Pavers');
    if (prod.is_new) prodCreated++; else prodUpdated++;

    const internalSku = `RAPHAEL-RP${code}-${size.replace('x', '')}-F`;
    const sku = await upsertSku(prod.id, `RP${code}`, internalSku, `${size} Flamed 20mm`, 'sqft');
    if (sku.is_new) skuCreated++; else skuUpdated++;

    await upsertPricing(sku.id, 3.25, 6.50, 'per_sqft');
    await upsertPackaging(sku.id, sqftBox, pcsBox);
  }
  console.log(`  ${PAVERS.length} pavers processed`);

  // ---- SUMMARY ----
  console.log('\n=== Import Complete ===');
  console.log(`Products created: ${prodCreated}`);
  console.log(`Products updated: ${prodUpdated}`);
  console.log(`SKUs created: ${skuCreated}`);
  console.log(`SKUs updated: ${skuUpdated}`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
