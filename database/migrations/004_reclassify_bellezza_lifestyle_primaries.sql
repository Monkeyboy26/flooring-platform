-- Migration 004: Reclassify Bellezza Ceramica lifestyle/room-scene primary images
-- Visual audit of all 357 Bellezza primary images identified 56 that are lifestyle
-- or room-scene photos incorrectly set as primary. These should be reclassified so
-- only product photos serve as primary images.
--
-- Products affected:
--   Acoustic MDF Sound Absorption Panel (room scenes with wooden slats)
--   Altea Matcha/Pine Green/Thistle Blue (bathroom scenes)
--   BPC Interior Panel (room scenes)
--   Ceppo Sabbia (room scene)
--   Exterior Composite Wall Panel (building exterior photos)
--   Frammenti (room scenes)
--   Grunge (room scenes)
--   Leccese Cesellata (ambiance + Perla 120x120 room scenes)
--   Limit Rose (bathroom scene)
--   Mixit Concept (styled product shots with props)
--   Puccini Marfil (room scenes)
--   Spatula (room scene)
--   Statuario Spider (room scene)
--   Temper (room scenes)
--   Unique Ceppo Bone (room scene)
--
-- Run: docker exec -i flooring-db psql -U postgres -d flooring_pim < database/migrations/004_reclassify_bellezza_lifestyle_primaries.sql

BEGIN;

UPDATE media_assets
SET asset_type = 'lifestyle', sort_order = 30
WHERE id IN (
  '2d104c29-d68e-416f-a1e1-5326fd3dd650',
  'efa61f6b-a33c-4969-8bdc-0caa6f69eddc',
  '20e0f89f-152b-4447-a664-3526962d3320',
  'a328ca96-aee2-401e-94d4-a0e0125a4847',
  'c0691ef4-e535-46a7-b393-b448ac4e2fd4',
  '3303fd36-11ea-4413-979b-80d642774a87',
  '511ac769-e942-4de5-b2a4-3a80a5331931',
  '07d4f092-cfc0-4591-a005-425fbbfbd05a',
  'd90c5562-621a-4467-8a3e-a4e2e0e40412',
  '09dfe4eb-ea9d-4a8e-9349-99f01d7d8cb0',
  'db936fff-579d-4f6c-b50b-18bc2ad25728',
  'b151ebac-64f6-4217-8b05-c9b910bf0246',
  '2e2aa94f-06f8-4987-8f2d-95b924dd07e9',
  'c6142384-fd7a-4b2f-b974-f092e0f96ee8',
  'd7ea59e4-a66c-4b47-b272-a373a48f816c',
  '79a4a71c-f7c3-48e3-ba04-48b87a254f95',
  '3d5386f3-522d-4dd0-99f3-dd7b53849f30',
  '3a71369e-416d-449d-beda-b4ad1adb6a4d',
  'f2a31132-41e0-4d6c-8d47-ca2172aa37b5',
  '67a413d4-fa4d-43e9-87c5-c9580e5f53f0',
  '8e0cb52e-96f8-436a-b20d-f8f93b22bfd1',
  '820aa666-a95c-4019-bc5c-ffa2a94fe666',
  'b988d903-61bc-4dcf-8767-3b36c5ec9fb8',
  '74c5e0e4-6936-4d00-b46d-a94da768494b',
  '44f26060-3f78-4000-8f43-f6251794e1cf',
  '5ff3b5f1-fa29-49bb-9627-db531adfecac',
  '653e1614-c20f-47c4-9e58-c9c6695fa968',
  '76bf728a-86a6-492c-9ae0-7089f6007834',
  '80e5682b-9067-4564-b8c1-d9a782f8f249',
  'df5e157f-141a-49eb-8e9f-67c8feab548e',
  '997c6521-2c4d-4fb6-827d-35fea4eb3607',
  '3614cc1d-16cd-41c3-9166-359f1f335183',
  'b9d1fbe1-351c-4fce-80e6-147b3fe35697',
  '085210c3-0705-40ef-b707-0b352386e1ea',
  '42325977-63a7-4b72-b376-00182ed1f312',
  '6af7b074-5c4d-4273-99fa-6e3897280142',
  '7709a9a4-1618-4715-83f2-bf2e3f3dc02e',
  '882071d8-e7f3-4a29-8f28-4f527a9eae5e',
  'b81d96bf-c826-4683-9ae2-b13f354eeb1b',
  '11c739b2-662e-472b-b36a-5b4f7fc292cd',
  '30d7e3df-624e-4ec8-85ef-641f2c8df1c7',
  'aa8e3d9e-f8d5-4407-93e0-3953866ad1ae',
  'dbd63615-2e0a-4048-819b-c258c4467215',
  '44b7c218-e22a-4825-b437-8858d0bc5d46',
  'd2f37566-b054-47ea-8fe8-d3fb3c5a7f61',
  'dadd7488-f452-47c1-9e2b-d64b9986f17c',
  'e7dd586d-7714-403a-a834-b3c620c13901',
  '18ab5e6f-e134-48b4-9b7c-88ca2cb8c493',
  'c44c891b-fa1d-4c07-9fe2-71cd59005a36',
  'c6e75223-eafe-441f-8986-1e23c268e7ff',
  '53845023-8bf1-4396-bede-a470b44dd450',
  '5944d4cd-069c-467d-81de-f9e24ff6d629',
  'd72e90db-303f-4ff2-ba5c-fb91b08ca272',
  'a354fb9e-9722-4fd5-b683-8d2989c80202',
  '26564266-627a-45d4-98f7-345524cf325c',
  '2ba0506c-f0f3-4d6a-9b4f-29c859e7895c'
)
AND asset_type = 'primary';

COMMIT;
