-- Read-only diagnosis of the household category tree (ADR 0006). Answers "did
-- the move to the shared tree land correctly, and where is Unspecified still
-- large?" without composing the queries again each time. Run with psql against
-- the application database; it performs no writes.
--   sudo -u private-finances psql -d private_finances -X -A -F' | ' -f category-diagnosis.sql
-- Output contains payment descriptions and amounts: treat it as private
-- financial evidence and never paste it into logs, Git or a model prompt.

\echo === INVARIANTS (every count below must be 0) ===
SELECT
  (SELECT count(*) FROM transactions t
     WHERE t.category_id IS NOT NULL
       AND EXISTS(SELECT 1 FROM category_tree c WHERE c.parent_id=t.category_id))
    AS filed_on_a_heading,
  (SELECT count(*) FROM transactions
     WHERE kind='personal_expense' AND category_id IS NULL)
    AS expense_without_category,
  (SELECT count(*) FROM transactions
     WHERE category_id IS NOT NULL
       AND category IS DISTINCT FROM category_path(category_id))
    AS path_mirror_out_of_step,
  (SELECT count(*) FROM category_tree WHERE depth > 3) AS deeper_than_three,
  (SELECT count(*) FROM transactions t
     WHERE t.category_id IS NOT NULL
       AND NOT EXISTS(SELECT 1 FROM category_tree c WHERE c.id=t.category_id))
    AS category_missing_from_tree;

\echo
\echo === SPENDING BY BRANCH, WITH THE SUBTREE ROLLED UP ===
WITH RECURSIVE descendants AS (
  SELECT id AS root, id FROM category_tree WHERE parent_id IS NULL
  UNION ALL
  SELECT d.root, c.id FROM category_tree c JOIN descendants d ON c.parent_id=d.id
)
SELECT r.name AS branch, t.currency,
       count(*) AS payments,
       (-sum(t.amount_minor))::text AS outflow_minor
FROM transactions t
JOIN descendants d ON d.id=t.category_id
JOIN category_tree r ON r.id=d.root
WHERE t.kind='personal_expense' AND t.status='booked' AND t.amount_minor<0
GROUP BY r.name, t.currency
ORDER BY (-sum(t.amount_minor)) DESC;

\echo
\echo === HOW MUCH IS STILL UNSPECIFIED, AND IS IT FALLING? ===
SELECT to_char(t.booked_at AT TIME ZONE 'Europe/Riga', 'YYYY-MM') AS month,
       count(*) FILTER (WHERE lower(n.name)='unspecified') AS unspecified,
       count(*) AS classified,
       round(100.0 * count(*) FILTER (WHERE lower(n.name)='unspecified')
             / nullif(count(*), 0), 1) AS percent_unspecified
FROM transactions t JOIN category_tree n ON n.id=t.category_id
WHERE t.kind='personal_expense'
GROUP BY 1 ORDER BY 1 DESC;

\echo
\echo === LARGEST PAYMENTS STILL UNSPECIFIED (the ones worth deciding by hand) ===
SELECT left(t.id::text, 8) AS id, t.owner, t.currency, t.amount_minor::text AS minor,
       left(t.description, 40) AS description,
       coalesce(t.source_details->>'mcc', t.source_details->>'merchant_category_code') AS mcc,
       n.name AS branch,
       to_char(t.booked_at AT TIME ZONE 'Europe/Riga', 'YYYY-MM-DD') AS booked_riga
FROM transactions t JOIN category_tree n ON n.id=t.category_id
WHERE lower(n.name)='unspecified' AND t.amount_minor<0
ORDER BY t.amount_minor LIMIT 40;

\echo
\echo === WHAT THE VERSION 22 MIGRATION DID, BY METHOD ===
SELECT method, count(*) AS payments FROM category_migration_log
GROUP BY method ORDER BY count(*) DESC;

\echo
\echo === LEGACY PATHS THAT FELL THROUGH TO THE ROOT CATCH-ALL ===
SELECT legacy_path, count(*) AS payments FROM category_migration_log
WHERE method='catch_all' GROUP BY legacy_path ORDER BY count(*) DESC;

\echo
\echo === UNUSED CATEGORIES (candidates for removal; removal reassigns, never orphans) ===
SELECT category_path(c.id) AS path
FROM category_tree c
WHERE NOT EXISTS(SELECT 1 FROM category_tree k WHERE k.parent_id=c.id)
  AND NOT EXISTS(SELECT 1 FROM transactions t WHERE t.category_id=c.id)
ORDER BY 1;

-- A rule matches a whole bank description, or a whole counterparty identifier,
-- by exact equality. A merchant whose description varies per payment therefore
-- needs one rule per variant, and each of those matches almost nothing. The
-- three queries below size that problem rather than estimating it: how many
-- rules exist, how many payments each actually reaches, and which descriptions
-- are so close to each other that one better matcher would replace many rules.

\echo
\echo === RULE COUNT AND HOW MUCH WORK THE RULES ACTUALLY DO ===
SELECT r.owner, r.match_field,
       count(*) AS rules,
       count(*) FILTER (WHERE NOT r.active) AS disabled,
       count(*) FILTER (WHERE r.active AND m.payments = 0) AS match_nothing,
       count(*) FILTER (WHERE r.active AND m.payments = 1) AS match_one_payment,
       coalesce(sum(m.payments), 0) AS payments_reached
FROM classification_rules r
LEFT JOIN LATERAL (
  SELECT count(*) AS payments FROM transactions t
  WHERE t.owner = r.owner
    AND CASE r.match_field
          WHEN 'description' THEN t.description = r.match_value
          ELSE t.source_details->>'counterpartyIdentifier' = r.match_value
        END
) m ON true
GROUP BY r.owner, r.match_field ORDER BY 1, 2;

\echo
\echo === ACTIVE RULES THAT NO PAYMENT MATCHES (dead weight, safe to review first) ===
SELECT r.owner, r.match_field, left(r.match_value, 60) AS matcher, r.version
FROM classification_rules r
WHERE r.active AND NOT EXISTS (
  SELECT 1 FROM transactions t WHERE t.owner = r.owner
    AND CASE r.match_field
          WHEN 'description' THEN t.description = r.match_value
          ELSE t.source_details->>'counterpartyIdentifier' = r.match_value
        END
)
ORDER BY 1, 3 LIMIT 60;

\echo
\echo === DESCRIPTIONS SHARING A FIRST WORD (where one better matcher replaces many rules) ===
SELECT split_part(btrim(r.match_value), ' ', 1) AS leading_word,
       count(*) AS rules, count(DISTINCT r.kind) AS distinct_kinds,
       count(DISTINCT r.category_id) AS distinct_categories
FROM classification_rules r
WHERE r.active AND r.match_field = 'description' AND btrim(r.match_value) <> ''
GROUP BY 1 HAVING count(*) > 1
ORDER BY count(*) DESC LIMIT 40;

-- ---------------------------------------------------------------------------
-- Recognising the household's own money (migration 30).
--
-- A transfer between our own accounts must not be counted as spending. Most
-- money-transfer payments carry no counterparty IBAN and only 38 payments in
-- the whole ledger name a card, so recognition rests on what the owner has said
-- about a counterparty: the rules they wrote, and the transfers they categorise
-- by hand, matched on a spelling-insensitive key. These queries say how far that
-- reaches; no description, recipient or card number is printed.
-- ---------------------------------------------------------------------------

\echo '-- identifiers registered per account, by where they came from'
SELECT a.purpose,
       i.scheme,
       i.registered_by,
       count(*) AS identifiers,
       count(DISTINCT (i.source, i.account_id)) AS accounts
FROM own_account_identifiers i
JOIN own_accounts a ON a.source = i.source AND a.account_id = i.account_id
GROUP BY 1, 2, 3
ORDER BY 4 DESC;

\echo '-- accounts still carrying no identifier at all (a card-to-card transfer to one of these cannot be recognised)'
SELECT a.purpose, count(*) AS accounts
FROM own_accounts a
WHERE NOT EXISTS (SELECT 1 FROM own_account_identifiers i
                  WHERE i.source = a.source AND i.account_id = a.account_id)
  AND a.identifier_hash IS NULL
GROUP BY 1 ORDER BY 2 DESC;

\echo '-- counterparties the owner has identified, as rules, by kind'
SELECT r.kind, r.active, count(*) AS counterparties
FROM classification_rules r
WHERE r.match_field = 'description'
  AND r.kind IN ('internal_transfer', 'investment', 'non_personal')
GROUP BY 1, 2 ORDER BY 3 DESC;

\echo '-- transfers still counted as spending whose counterparty recurs (each one the owner categorises is remembered, so the repeats stop)'
SELECT count(*) AS payments, count(DISTINCT lower(btrim(d))) AS counterparties
FROM (
  SELECT coalesce(t.source_details->>'description', t.description) AS d
  FROM transactions t
  WHERE t.kind = 'personal_expense' AND t.provisional
    AND t.amount_minor < 0 AND t.status = 'booked'
    AND coalesce(t.source_details->>'mcc',
                 t.source_details->>'merchant_category_code') = '4829'
) x
WHERE lower(btrim(d)) IN (
  SELECT lower(btrim(coalesce(t.source_details->>'description', t.description)))
  FROM transactions t
  WHERE coalesce(t.source_details->>'mcc',
                 t.source_details->>'merchant_category_code') = '4829'
  GROUP BY 1 HAVING count(*) > 1
);

\echo '-- outgoing money-transfer payments: what they are counted as, and what could identify them'
SELECT t.kind,
       CASE WHEN t.provisional THEN 'provisional' ELSE 'settled' END AS state,
       CASE WHEN t.source_details->>'description' ~ '^[0-9]{4,8}[^0-9A-Za-z]*\*+[^0-9A-Za-z]*[0-9]{4}$'
              THEN 'masked card only'
            WHEN t.source_details->>'counterIban' IS NOT NULL THEN 'counterparty IBAN'
            ELSE 'name or other text' END AS evidence,
       count(*) AS payments
FROM transactions t
WHERE t.amount_minor < 0 AND t.status = 'booked'
  AND coalesce(t.source_details->>'mcc',
               t.source_details->>'merchant_category_code') = '4829'
GROUP BY 1, 2, 3
ORDER BY 4 DESC;

\echo '-- invariants: each must be zero'
SELECT 'non-spending money still carrying a category' AS invariant, count(*) AS rows
FROM transactions
WHERE kind IN ('internal_transfer', 'investment') AND category_id IS NOT NULL
UNION ALL
SELECT 'identity overrode a decision a person made', count(*)
FROM transactions t
WHERE t.classification_source = 'identity'
  AND EXISTS (SELECT 1 FROM audit_events a
              WHERE a.transaction_id = t.id AND a.event = 'classified')
UNION ALL
SELECT 'identifier pointing at no account', count(*)
FROM own_account_identifiers i
WHERE NOT EXISTS (SELECT 1 FROM own_accounts a
                  WHERE a.source = i.source AND a.account_id = i.account_id)
UNION ALL
SELECT 'a counterparty rule that names nobody', count(*)
FROM classification_rules
WHERE match_field = 'description' AND btrim(match_value) = ''
  AND kind IN ('internal_transfer', 'investment', 'non_personal');
