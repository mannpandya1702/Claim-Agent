-- 0002_seed.sql — fictional customers and claims for the demo project (seed as a migration).
-- 555-01xx numbers are reserved for fiction; every date is fixed, never relative to now().
-- Emails are left null here and set from OWNER_EMAIL by `deno task reset` (Resend's free tier
-- delivers only to the account owner, and the address never belongs in a public repo).
-- Teague Ashdown deliberately has no email on file: the no_email_on_file branch.

insert into customers (id, phone_e164, first_name, last_name, date_of_birth, policy_number) values
  ('6b0d6f0e-1c11-4c7a-9a01-000000000101', '+16025550101', 'Tobias', 'Halvorsen', '1986-03-14', 'POL-7301'),
  ('6b0d6f0e-1c11-4c7a-9a01-000000000102', '+16025550102', 'Ronan', 'Quintero', '1979-11-02', 'POL-7302'),
  ('6b0d6f0e-1c11-4c7a-9a01-000000000103', '+16025550103', 'Sloane', 'Marchetti', '1992-07-21', 'POL-7303'),
  ('6b0d6f0e-1c11-4c7a-9a01-000000000104', '+16025550104', 'Teague', 'Ashdown', '1965-01-30', 'POL-7304'),
  ('6b0d6f0e-1c11-4c7a-9a01-000000000105', '+16025550105', 'Ines', 'Lindqvist', '1990-05-09', 'POL-7305');

insert into claims (customer_id, claim_number, claim_type, status, status_detail, documents_required, documents_due,
                    adjuster_name, filed_on, updated_on, amount_approved) values
  -- Tobias: F1 happy path (two claims), F2 auth failure, info email, returning caller
  ('6b0d6f0e-1c11-4c7a-9a01-000000000101', 'CLM-240115', 'auto', 'payment_issued',
   'Payment issued by direct deposit', '{}', null, 'Leona Fairbanks', '2026-09-02', '2026-10-08', 4820.00),
  ('6b0d6f0e-1c11-4c7a-9a01-000000000101', 'CLM-240198', 'home', 'awaiting_documents',
   'Water damage in the kitchen; review is paused until the documents arrive',
   '{"photos of the damage","a contractor estimate","proof of ownership for the damaged items"}',
   '2026-10-24', 'Leona Fairbanks', '2026-09-28', '2026-10-06', null),
  -- Ronan: F4 representative escalation
  ('6b0d6f0e-1c11-4c7a-9a01-000000000102', 'CLM-240211', 'auto', 'under_review',
   'A decision is expected within 5 business days', '{}', null, 'Bertrand Wexley', '2026-10-01', '2026-10-09', null),
  -- Sloane: denied + appeal (knowledge base)
  ('6b0d6f0e-1c11-4c7a-9a01-000000000103', 'CLM-240177', 'property', 'denied',
   'The item class is not covered by the policy; there is a 30-day appeal window', '{}', null, 'Leona Fairbanks',
   '2026-09-15', '2026-10-03', null),
  -- Teague: early-stage status, no adjuster yet
  ('6b0d6f0e-1c11-4c7a-9a01-000000000104', 'CLM-240230', 'home', 'received',
   'Received and waiting for an adjuster to be assigned', '{}', null, null, '2026-10-10', '2026-10-10', null);
-- Ines Lindqvist has no claims: the no_claims branch. +1 602 555 0199 matches nobody: F3 not found.
