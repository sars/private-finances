-- Read-only diagnosis of receipt matching. Answers "why is this receipt not
-- linked?" without composing the queries again each time. Run with psql against
-- the application database; it performs no writes.
--   sudo -u private-finances psql -d private_finances -X -A -F' | ' -f receipt-diagnosis.sql
-- Output contains merchant and payment descriptions: treat it as private
-- financial evidence and never paste it into logs, Git or a model prompt.

\echo === RECEIPT JOBS ===
SELECT left(id::text, 8) AS id, owner, state, reason,
       extraction->>'date' AS r_date,
       left(extraction->>'merchant', 24) AS r_merchant,
       extraction->>'amountMinor' AS r_amt, extraction->>'currency' AS r_cur,
       (transaction_id IS NOT NULL) AS linked,
       left(duplicate_of::text, 8) AS duplicate_of,
       to_char(created_at AT TIME ZONE 'Europe/Riga', 'MM-DD HH24:MI') AS created_riga
FROM receipt_jobs ORDER BY created_at;

\echo
\echo === RECEIPTS SHARING A PAYMENT (each payment should hold at most one) ===
SELECT left(transaction_id::text, 8) AS payment, count(*) AS receipts,
       string_agg(left(id::text, 8) || ':' || state, ', ' ORDER BY created_at) AS jobs
FROM receipt_jobs WHERE transaction_id IS NOT NULL
GROUP BY transaction_id HAVING count(*) > 1;

\echo
\echo === LIKELY DUPLICATE RECEIPTS (same purchase date, total and currency) ===
SELECT extraction->>'date' AS r_date, extraction->>'amountMinor' AS r_amt,
       extraction->>'currency' AS r_cur, count(*) AS n,
       string_agg(left(id::text, 8) || ':' || state, ', ' ORDER BY created_at) AS jobs
FROM receipt_jobs WHERE state NOT IN ('not_receipt', 'deleted')
GROUP BY 1, 2, 3 HAVING count(*) > 1;

\echo
\echo === CANDIDATE DEBITS for pending receipts, -1..+6 days, matching total ===
\echo (day_offset > 3 or a pending status explains why automatic matching declined)
SELECT left(r.id::text, 8) AS receipt, r.extraction->>'date' AS r_date,
       t.owner, t.source, t.status,
       (t.booked_at AT TIME ZONE 'Europe/Riga')::date AS booked_riga,
       ((t.booked_at AT TIME ZONE 'Europe/Riga')::date - (r.extraction->>'date')::date) AS day_offset,
       t.currency, t.amount_minor, left(t.description, 24) AS descr,
       t.source_details->>'operationAmount' AS mono_op_amt
FROM receipt_jobs r
JOIN transactions t
  ON t.amount_minor < 0 AND t.owner IN ('rodion', 'katya')
 AND (t.booked_at AT TIME ZONE 'Europe/Riga')::date
     BETWEEN (r.extraction->>'date')::date - 1 AND (r.extraction->>'date')::date + 6
 AND ((t.currency = r.extraction->>'currency'
       AND t.amount_minor::text = '-' || (r.extraction->>'amountMinor'))
   OR (t.source = 'monobank'
       AND t.source_details->>'operationAmount' = '-' || (r.extraction->>'amountMinor')))
WHERE r.state = 'pending' AND r.extraction->>'date' IS NOT NULL
ORDER BY r.created_at, t.booked_at;

\echo
\echo === FEEDBACK DELIVERY STATE (attempts at 5 are abandoned) ===
SELECT state, feedback_state, feedback_attempts, count(*) AS n
FROM receipt_jobs GROUP BY 1, 2, 3 ORDER BY 1, 2;
